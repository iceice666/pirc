import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'gateway.dart';

// Memory/schedule requests use Web http.ts's actual gateway message. Do not
// replace a useful revision-conflict reason with a generic status label.
String attentionRequestError(Object error) {
  if (error is PlatformException) {
    final status = RegExp(r'^HTTP_(\d{3})$').firstMatch(error.code);
    if (status != null) {
      return error.message ?? 'Request failed (${status.group(1)})';
    }
  }
  return LiveController.describe(error);
}

/// Personal gateway state shared by the sidebar, tabs and Memory settings.
/// Generations prevent a slow read/account switch from undoing an acknowledged decision.
class AttentionState extends ChangeNotifier {
  AttentionState(this.gateway);
  final Gateway gateway;
  Json? memory;
  List<Json> schedules = [], missedRuns = [];
  String? memoryError, scheduleError;
  String? _memoryDecisionError;
  bool memoryLoading = false, scheduleLoading = false;
  String? memoryBusy;
  final runBusy = <String>{};
  final _decidedRuns = <String>{};
  int _epoch = 0,
      _memoryRead = 0,
      _scheduleRead = 0,
      memoryRevision = 0,
      scheduleRevision = 0;
  bool _disposed = false;
  int _externalMemoryChange = 0;
  Future<void> memoryChanged() {
    ++_externalMemoryChange;
    return refreshMemory();
  }

  List<Json> get proposals => rows(
    memory?['proposals'],
  ).where((p) => p['status'] == 'pending').toList();
  int get count => proposals.length + missedRuns.length;
  Json? get nextSchedule {
    final candidates =
        schedules
            .where((s) => s['status'] == 'active' && s['nextRunAt'] is num)
            .toList()
          ..sort(
            (a, b) => (a['nextRunAt'] as num).compareTo(b['nextRunAt'] as num),
          );
    return candidates.firstOrNull;
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  void reset() {
    ++_epoch;
    ++_memoryRead;
    ++_scheduleRead;
    ++memoryRevision;
    ++scheduleRevision;
    memory = null;
    schedules = [];
    missedRuns = [];
    memoryError = scheduleError = memoryBusy = null;
    _memoryDecisionError = null;
    memoryLoading = scheduleLoading = false;
    runBusy.clear();
    _decidedRuns.clear();
    _changed();
  }

  Future<void> refresh({bool preserveUnchangedMemory = false}) async =>
      Future.wait([
        refreshMemory(preserveUnchanged: preserveUnchangedMemory),
        refreshSchedules(),
      ]);
  Future<void> refreshMemory({bool preserveUnchanged = false}) async {
    final epoch = _epoch, request = ++_memoryRead;
    memoryLoading = true;
    _changed();
    try {
      final response = await gateway.request('/api/memory');
      if (_disposed || epoch != _epoch || request != _memoryRead) return;
      final unchanged = preserveUnchanged && _sameJson(memory, response);
      memory = response;
      // A successful background read is review data, not a successful decision.
      memoryError = _memoryDecisionError;
      if (!unchanged) ++memoryRevision;
    } catch (e) {
      if (epoch == _epoch && request == _memoryRead) {
        memoryError = attentionRequestError(e);
      }
    } finally {
      if (epoch == _epoch && request == _memoryRead) {
        memoryLoading = false;
        _changed();
      }
    }
  }

  Future<void> refreshSchedules() async {
    final epoch = _epoch, request = ++_scheduleRead;
    scheduleLoading = true;
    _changed();
    try {
      final response = await gateway.request('/api/schedules');
      final listed = rows(response['schedules']);
      String? detailError;
      final details = await Future.wait(
        listed.where((s) => (s['attention'] as num? ?? 0) > 0).map((
          schedule,
        ) async {
          try {
            final data = await gateway.request(
              '/api/schedules/${enc('${schedule['id']}')}',
            );
            final current = obj(data['schedule']);
            return [
              for (final run in rows(
                data['runs'],
              ).where((r) => r['status'] == 'missed'))
                <String, dynamic>{
                  'schedule': current.isEmpty ? schedule : current,
                  'run': run,
                },
            ];
          } catch (e) {
            detailError = '${schedule['title']}: ${attentionRequestError(e)}';
            // A detail failure must not silently remove an already displayed missed run.
            return missedRuns
                .where((item) => obj(item['schedule'])['id'] == schedule['id'])
                .toList();
          }
        }),
      );
      final runs = details
          .expand((d) => d)
          .where((item) => !_decidedRuns.contains(obj(item['run'])['id']))
          .toList();
      for (final item in runs) {
        final schedule = obj(item['schedule']), run = obj(item['run']);
        try {
          final wall = await gateway.call('wallInput', {
            'at': run['dueAt'],
            'timezone': schedule['timezone'],
          });
          item['wallTime'] = wall is String
              ? wall.replaceFirst('T', ' ')
              : null;
        } catch (_) {
          item['wallTime'] = null;
        }
      }
      if (_disposed || epoch != _epoch || request != _scheduleRead) return;
      schedules = listed;
      ++scheduleRevision;
      missedRuns = runs;
      scheduleError = detailError;
    } catch (e) {
      if (epoch == _epoch && request == _scheduleRead) {
        scheduleError = attentionRequestError(e);
      }
    } finally {
      if (epoch == _epoch && request == _scheduleRead) {
        scheduleLoading = false;
        _changed();
      }
    }
  }

  Future<void> decideProposal(Json proposal, bool approve) => changeMemory(
    '${proposal['id']}',
    '/api/memory/proposals/${enc('${proposal['id']}')}/${approve ? 'approve' : 'reject'}',
    approve && obj(proposal['target'])['revision'] != null
        ? {'targetRevision': obj(proposal['target'])['revision']}
        : {},
  );
  Future<void> forget(String id) =>
      changeMemory(id, '/api/memory/entries/${enc(id)}/forget', {});
  Future<void> restore(String id, {int? revision}) => changeMemory(
    id,
    '/api/memory/entries/${enc(id)}/restore',
    {'revision': ?revision},
  );
  Future<void> changeMemory(String key, String path, Json body) async {
    if (memoryBusy != null) return;
    final epoch = _epoch, externalChange = _externalMemoryChange;
    ++_memoryRead;
    memoryLoading = false;
    memoryBusy = key;
    _memoryDecisionError = null;
    memoryError = null;
    _changed();
    try {
      final response = await gateway.request(path, method: 'POST', body: body);
      if (_disposed || epoch != _epoch) return;
      if (externalChange != _externalMemoryChange) {
        await refreshMemory();
        return;
      }
      ++_memoryRead;
      memoryLoading = false;
      memory = response;
      ++memoryRevision;
    } catch (e) {
      if (_disposed || epoch != _epoch) return;
      final message = attentionRequestError(e);
      _memoryDecisionError = message;
      // Refresh data for review; never retry the mutation with a newer revision.
      await refreshMemory();
      if (epoch == _epoch) memoryError = message;
    } finally {
      if (epoch == _epoch) {
        memoryBusy = null;
        _changed();
      }
    }
  }

  Future<List<Json>> history(String entryId) async {
    final epoch = _epoch;
    final response = await gateway.request(
      '/api/memory/entries/${enc(entryId)}/history',
    );
    return epoch == _epoch && !_disposed ? rows(response['versions']) : [];
  }

  Future<void> decideMissed(Json item, bool allow) async {
    final id = '${obj(item['run'])['id']}',
        scheduleId = '${obj(item['schedule'])['id']}';
    if (!runBusy.add(id)) return;
    final epoch = _epoch;
    ++_scheduleRead;
    scheduleLoading = false;
    scheduleError = null;
    _changed();
    try {
      await gateway.request(
        allow
            ? '/api/schedules/${enc(scheduleId)}/run'
            : '/api/schedules/${enc(scheduleId)}/runs/${enc(id)}/dismiss',
        method: 'POST',
        body: allow ? {'runId': id} : null,
      );
      if (_disposed || epoch != _epoch) return;
      ++_scheduleRead;
      _decidedRuns.add(id);
      missedRuns.removeWhere((item) => obj(item['run'])['id'] == id);
    } catch (e) {
      if (epoch == _epoch) scheduleError = attentionRequestError(e);
    } finally {
      if (epoch == _epoch && !_disposed) {
        final error = scheduleError;
        runBusy.remove(id);
        _changed();
        await refreshSchedules();
        if (epoch == _epoch && error != null) {
          scheduleError = error;
          _changed();
        }
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    ++_epoch;
    super.dispose();
  }
}

String untilRun(num at, {DateTime? now}) {
  final delta = at - (now ?? DateTime.now()).millisecondsSinceEpoch;
  if (delta < 60000) return 'in under a minute';
  if (delta < 3600000) return 'in ${(delta / 60000).round()}m';
  if (delta < 86400000) return 'in ${(delta / 3600000).round()}h';
  return 'in ${(delta / 86400000).round()}d';
}

String describeOrigins(dynamic value) {
  final origins = value is List ? value.map((o) => '$o').toList() : <String>[];
  final tools = origins
      .where((o) => o.startsWith('tool:'))
      .map(
        (o) => o == 'tool:bash:network'
            ? 'bash fetching from the network'
            : o.substring(5),
      );
  final custom = origins
      .where((o) => o.startsWith('custom:'))
      .map((o) => o.substring(7));
  final parts = [
    if (origins.contains('user')) 'your words',
    if (origins.contains('assistant')) 'the assistant',
    if (tools.isNotEmpty) 'tool output (${tools.join(', ')})',
    if (custom.isNotEmpty) '${custom.join(', ')} messages',
    if (origins.contains('unknown')) 'an unknown source',
  ];
  return parts.isEmpty ? '' : 'From ${parts.join(', ')}';
}

String describeVersion(Json version, Json sessions) {
  final actor = '${version['actor']}';
  final name = actor.startsWith('session:')
      ? sessions[actor.substring(8)]
      : null;
  final who = actor.startsWith('session:')
      ? 'the assistant${name != null ? ' ($name)' : ''}'
      : 'you';
  final op =
      const {
        'add': 'Added',
        'replace': 'Changed',
        'remove': 'Removed',
        'restore': 'Restored',
        'forget': 'Forgotten',
      }[version['op']] ??
      version['op'];
  return '$op by $who';
}

/// Compare decoded JSON independent of object key insertion order. History
/// resume still reconciles server data without treating an unchanged read as
/// a new Memory view that would clear a retained local confirmation.
bool _sameJson(Object? first, Object? second) {
  if (identical(first, second)) return true;
  if (first is List && second is List) {
    if (first.length != second.length) return false;
    for (var i = 0; i < first.length; i++) {
      if (!_sameJson(first[i], second[i])) return false;
    }
    return true;
  }
  if (first is Map && second is Map) {
    if (first.length != second.length) return false;
    for (final key in first.keys) {
      if (!second.containsKey(key) || !_sameJson(first[key], second[key])) {
        return false;
      }
    }
    return true;
  }
  return first == second;
}
