import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../l10n/app_i18n.dart';
import 'gateway.dart';

/// Explicit-action pots client using the existing paired transport.
/// Reading never authorizes execution or answers source approvals.
class PotsState extends ChangeNotifier {
  PotsState(this.controller, {DateTime Function()? clock})
    : clock = clock ?? DateTime.now {
    _identity = _clientIdentity;
    controller.addListener(_external);
  }

  final LiveController controller;
  final DateTime Function() clock;
  Json? snapshot;
  String? error;
  bool loading = false, busy = false;
  int epoch = 0, _read = 0;
  bool _disposed = false;
  late String _identity;
  String? _accountKey, _createSpec, _createKey;

  String get _clientIdentity => jsonEncode([
    controller.origin,
    controller.clientId,
    controller.pairingStamp,
  ]);
  bool get paired =>
      controller.origin?.isNotEmpty == true &&
      controller.clientId?.isNotEmpty == true &&
      controller.pairingStamp?.isNotEmpty == true;
  bool get ready =>
      paired &&
      _identity == _clientIdentity &&
      snapshot != null &&
      !loading &&
      !busy;
  List<Json> _records(String category) =>
      (snapshot?[category] as List? ?? const []).cast<Json>();
  List<Json> get responsibilities => _records('responsibilities');
  List<Json> get suggestions => _records('suggestions');
  List<Json> get tasks => _records('tasks');
  List<Json> get workspaces => _records('workspaces');

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  bool _current(int token) =>
      !_disposed && epoch == token && _identity == _clientIdentity;
  void _external() {
    if (_identity == _clientIdentity) return;
    _identity = _clientIdentity;
    epoch++;
    _read++;
    snapshot = null;
    _accountKey = _createSpec = _createKey = error = null;
    loading = busy = false;
    _changed();
    if (paired) unawaited(load());
  }

  Future<void> load({bool clearError = true}) async {
    if (_disposed) return;
    _external();
    if (!paired) {
      snapshot = null;
      _changed();
      return;
    }
    final token = epoch, read = ++_read;
    final stamp = controller.pairingStamp!;
    snapshot = null; // Never retain a private preview after a failed refresh.
    loading = true;
    if (clearError) error = null;
    _changed();
    try {
      final next = await controller.gateway.request(
        '/api/pots?limit=100',
        pairingStamp: stamp,
      );
      if (!_current(token) || read != _read) return;
      if (next['workspaces'] is! List ||
          next['accountKey'] is! String ||
          (next['accountKey'] as String).isEmpty ||
          obj(next['actor'])['kind'] != 'pots' ||
          next['observationMode'] != 'session_progress_events' ||
          ['responsibilities', 'suggestions', 'tasks'].any(
            (key) => next[key] is! List || (next[key] as List).length > 100,
          )) {
        throw const FormatException('Unsupported pots overview');
      }
      if (_accountKey != null && _accountKey != next['accountKey']) {
        epoch++; // Fence pending actions/drafts even if the device ID was reused.
        busy = false;
        _createSpec = _createKey = null;
      }
      _accountKey = next['accountKey'] as String;
      snapshot = {
        ...next,
        for (final key in [
          'responsibilities',
          'suggestions',
          'tasks',
          'workspaces',
        ])
          key: rows(next[key]),
      };
    } catch (_) {
      if (_current(token) && read == _read) {
        error = tr('Unable to load pots. Refresh to try again.');
      }
    } finally {
      if (!_disposed && read == _read && _identity == _clientIdentity) {
        loading = false;
        _changed();
      }
    }
  }

  static String _commandId() => List.generate(
    16,
    (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();

  // Snapshot membership prevents a stale widget closure using an old account's
  // record after re-pairing. Revisions/generations are also enforced by Gateway.
  bool _record(Json record, String category) =>
      _records(category).any((r) => identical(r, record));

  Future<bool> _mutate(String path, Json body) async {
    if (!ready) return false;
    final token = epoch, stamp = controller.pairingStamp!;
    busy = true;
    error = null;
    _read++; // Ignore GET responses issued before this mutation.
    _changed();
    var success = false;
    try {
      await controller.gateway.request(
        path,
        method: 'POST',
        body: body,
        pairingStamp: stamp,
      );
      success = _current(token);
    } catch (_) {
      if (_current(token)) {
        error = tr(
          'Pots request failed or changed. Refreshed; review before trying again.',
        );
      }
    } finally {
      if (_current(token)) {
        // GET only: never replay an unknown-outcome POST.
        await load(clearError: false);
        if (_current(token)) {
          busy = false;
          _changed();
        }
      }
    }
    return success && _current(token);
  }

  Future<bool> create({
    required String purpose,
    required List<String> scopes,
    required int observations,
    required int dispatches,
    required int concurrency,
  }) async {
    if (!ready ||
        purpose.trim().isEmpty ||
        utf8.encode(purpose.trim()).length > 2000 ||
        scopes.isEmpty ||
        scopes.length > 32 ||
        scopes.toSet().length != scopes.length ||
        scopes.any((id) => !workspaces.any((w) => w['id'] == id)) ||
        observations < 1 ||
        observations > 1000000 ||
        dispatches < 0 ||
        dispatches > 1000000 ||
        concurrency < 1 ||
        concurrency > 32) {
      return false;
    }
    final spec = <String, dynamic>{
      'purpose': purpose.trim(),
      'scopes': scopes
          .map((id) => {'workspaceId': id, 'access': 'progress'})
          .toList(),
      'budgets': {
        'observations': observations,
        'dispatches': dispatches,
        'concurrency': concurrency,
      },
    };
    final encoded = jsonEncode(spec);
    if (_createSpec != encoded) {
      _createSpec = encoded;
      _createKey = _commandId();
    }
    final success = await _mutate('/api/pots/responsibilities', {
      ...spec,
      'idempotencyKey': _createKey,
    });
    if (success) _createSpec = _createKey = null;
    return success;
  }

  Future<bool> responsibility(Json r, String action) async {
    if (!_record(r, 'responsibilities') ||
        !const [
          'activate',
          'disable',
          'pause_observation',
          'resume_observation',
          'pause_coordination',
          'resume_coordination',
          'archive',
        ].contains(action) ||
        (action == 'archive' && r['enabled'] == true)) {
      return false;
    }
    return _mutate('/api/pots/responsibilities/${enc('${r['id']}')}/control', {
      'expectedRevision': r['revision'],
      'expectedGeneration': r['generation'],
      'action': {'type': action},
    });
  }

  bool actionable(Json s) {
    final until = s['snoozedUntil'], expires = obj(s['evidence'])['expiresAt'];
    final now = clock().millisecondsSinceEpoch;
    return const ['pending', 'snoozed'].contains(s['disposition']) &&
        expires is num &&
        expires > now &&
        (until == null || (until is num && until <= now));
  }

  Future<bool> track(Json s) async {
    if (!_record(s, 'suggestions') || !actionable(s)) return false;
    return _mutate('/api/pots/suggestions/${enc('${s['id']}')}/track', {
      'expectedRevision': s['revision'],
      'commandId': _commandId(),
    });
  }

  /// An unlinked suggestion that was dismissed or superseded.
  static bool archivable(Json s) =>
      s['taskId'] == null &&
      const ['dismissed', 'superseded'].contains(s['disposition']);

  static bool terminal(Json t) => const [
    'completed',
    'failed',
    'interrupted',
    'stopped',
  ].contains(t['status']);

  Future<bool> suggestion(Json s, String action) async {
    final allowed = action == 'archive'
        ? archivable(s)
        : const ['pending', 'snoozed'].contains(s['disposition']) &&
              const ['dismiss', 'snooze'].contains(action);
    if (!_record(s, 'suggestions') || !allowed) {
      return false;
    }
    return _mutate('/api/pots/suggestions/${enc('${s['id']}')}/control', {
      'expectedRevision': s['revision'],
      'action': {
        'type': action,
        if (action == 'snooze')
          'until': clock().millisecondsSinceEpoch + 3600000,
      },
    });
  }

  static bool validInstruction(String instruction) =>
      instruction.trim().isNotEmpty && utf8.encode(instruction).length <= 20000;

  bool canStart(Json t) =>
      ready &&
      _record(t, 'tasks') &&
      snapshot?['executionAvailable'] == true &&
      t['status'] == 'tracked' &&
      t['coordinationPaused'] != true &&
      t['takenOver'] != true &&
      t['execution'] == null &&
      t['executionSessionId'] == null;

  Future<bool> start(Json t, String instruction) async {
    if (!canStart(t) || !validInstruction(instruction)) return false;
    return _mutate('/api/pots/tasks/${enc('${t['id']}')}/start', {
      'expectedRevision': t['revision'],
      'expectedGeneration': t['controlGeneration'],
      'commandId': _commandId(),
      'instruction': instruction,
    });
  }

  Future<bool> task(Json t, String action) async {
    if (!_record(t, 'tasks') ||
        !const [
          'pause_coordination',
          'resume_coordination',
          'take_over',
          'stop',
          'archive',
        ].contains(action) ||
        (action == 'archive' && !terminal(t))) {
      return false;
    }
    return _mutate('/api/pots/tasks/${enc('${t['id']}')}/control', {
      'expectedRevision': t['revision'],
      'expectedGeneration': t['controlGeneration'],
      'action': {'type': action},
    });
  }

  @override
  void dispose() {
    _disposed = true;
    controller.removeListener(_external);
    snapshot = null;
    super.dispose();
  }
}
