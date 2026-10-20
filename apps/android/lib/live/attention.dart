import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'gateway.dart';

// Memory requests use Web http.ts's actual gateway message. Do not
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

/// Personal gateway memory state shared by Memory settings.
/// Generations prevent a slow read/account switch from undoing an acknowledged decision.
class AttentionState extends ChangeNotifier {
  AttentionState(this.gateway);
  final Gateway gateway;
  Json? memory;
  String? memoryError;
  String? _memoryDecisionError;
  bool memoryLoading = false;
  String? memoryBusy;
  int _epoch = 0, _memoryRead = 0, memoryRevision = 0;
  bool _disposed = false;
  int _externalMemoryChange = 0;
  Future<void> memoryChanged() {
    ++_externalMemoryChange;
    return refreshMemory();
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  void reset() {
    ++_epoch;
    ++_memoryRead;
    ++memoryRevision;
    memory = null;
    memoryError = memoryBusy = null;
    _memoryDecisionError = null;
    memoryLoading = false;
    _changed();
  }

  Future<void> refresh({bool preserveUnchangedMemory = false}) =>
      refreshMemory(preserveUnchanged: preserveUnchangedMemory);
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

  @override
  void dispose() {
    _disposed = true;
    ++_epoch;
    super.dispose();
  }
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
