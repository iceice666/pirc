import 'dart:async';
import 'package:flutter/foundation.dart';
import 'gateway.dart';

bool liveJob(Json task) => ['running', 'stopping'].contains(task['status']);
String jobDetail(Json task) => switch (task['status']) {
  'running' => task['tty'] == true ? 'tty' : '',
  'stopping' => 'stopping',
  'completed' =>
    task['exitCode'] != null && task['exitCode'] != 0
        ? 'exit ${task['exitCode']}'
        : 'done',
  'failed' =>
    task['exitCode'] != null
        ? 'exit ${task['exitCode']}'
        : '${task['error'] ?? 'failed'}',
  _ => '${task['status'] ?? ''}'.replaceFirst('_', ' '),
};

/// Session-scoped background work. Read responses never cross session/account
/// boundaries, and stop requests are never replayed after uncertain delivery.
class JobsState extends ChangeNotifier {
  JobsState(this.controller) {
    controller.addListener(_observe);
    controller.panelData.addListener(_panelUpdated);
    _events = controller.gateway.events.listen((event) {
      if (event['sessionId'] == _session &&
          event['type'] == 'panelChange' &&
          (event['data'] as List? ?? []).any(
            (s) => s == 'background' || s == 'team',
          )) {
        _schedule();
      }
    });
    _observe();
  }
  final LiveController controller;
  StreamSubscription<Json>? _events;
  String? _session, _origin, _client, _connection;
  bool _active = false, _running = false, _disposed = false;
  int _scope = 0, _outputRead = 0, _delay = 2000;
  Timer? _refresh, _poll, _arm, _clock;
  Json data = {};
  bool open = false, finishedOpen = false;
  String? expanded, armed, stopping, outputError, stopError;
  String output = '';
  DateTime now = DateTime.now();
  final cleared = <String>{};
  List<Json> get tasks => rows(data['backgroundTasks']).reversed.toList();
  List<Json> get live => tasks.where(liveJob).toList();
  List<Json> get finished =>
      tasks.where((t) => !liveJob(t) && !cleared.contains(t['id'])).toList();
  List<Json> get agents => rows(obj(data['team'])['agents'])
      .where(
        (a) =>
            !['stopped', 'failed', 'done'].contains(a['status'] ?? 'stopped'),
      )
      .toList();
  int get count => live.length + agents.length;
  bool get visible => count + finished.length > 0;
  Json? get expandedTask => tasks.where((t) => t['id'] == expanded).firstOrNull;
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  bool _valid(int scope) => !_disposed && scope == _scope;
  void _observe() {
    final c = controller;
    final session = c.chat ? null : c.sessionId;
    final changed =
        session != _session || c.origin != _origin || c.clientId != _client;
    final resumed = c.active && !_active;
    final reconnected = c.connection == 'live' && _connection != 'live';
    final ended = _running && !c.running;
    _connection = c.connection;
    _active = c.active;
    _running = c.running;
    if (changed) {
      ++_scope;
      ++_outputRead;
      _session = session;
      _origin = c.origin;
      _client = c.clientId;
      _refresh?.cancel();
      _poll?.cancel();
      _arm?.cancel();
      _clock?.cancel();
      data = {};
      open = false;
      finishedOpen = false;
      expanded = null;
      armed = null;
      stopping = null;
      stopError = null;
      outputError = null;
      output = '';
      cleared.clear();
    }
    if (!_active) {
      _poll?.cancel();
      _clock?.cancel();
    }
    if (changed || resumed || reconnected || ended) _schedule();
    if (resumed && open) {
      _timers();
      if (expanded != null) unawaited(loadOutput());
    }
    _notify();
  }

  void _schedule() {
    _refresh?.cancel();
    if (_session == null || !_active) return;
    _refresh = Timer(const Duration(milliseconds: 100), refresh);
  }

  void _panelUpdated() {
    if (_disposed ||
        _session == null ||
        _session != controller.sessionId ||
        _origin != controller.origin ||
        _client != controller.clientId) {
      return;
    }
    final next = controller.panelData.value;
    if (next == null) return;
    final previous = expandedTask?['status'];
    data = next;
    if (!visible) setOpen(false);
    _timers();
    _notify();
    if (expanded != null && previous != expandedTask?['status']) {
      unawaited(loadOutput());
    }
  }

  Future<void> refresh() async {
    if (_session == null || !_active || _disposed) return;
    await controller.panelData.refresh();
  }

  void setOpen(bool value) {
    open = value;
    now = DateTime.now();
    if (open) {
      unawaited(refresh());
      if (expanded != null) unawaited(loadOutput());
    } else {
      _poll?.cancel();
      _clock?.cancel();
    }
    _timers();
    _notify();
  }

  void _timers() {
    _clock?.cancel();
    if (open && _active && count > 0) {
      _clock = Timer.periodic(const Duration(seconds: 1), (_) {
        now = DateTime.now();
        _notify();
      });
    }
    _poll?.cancel();
    if (open && _active && expandedTask != null && liveJob(expandedTask!)) {
      _poll = Timer(Duration(milliseconds: _delay), () async {
        final changed = await loadOutput();
        _delay = changed ? 2000 : (_delay * 1.5).round().clamp(2000, 10000);
        if (!_disposed) _timers();
      });
    }
  }

  Future<void> toggleTask(Json task) async {
    ++_outputRead;
    _poll?.cancel();
    _delay = 2000;
    if (expanded == task['id']) {
      expanded = null;
      _notify();
      return;
    }
    expanded = '${task['id']}';
    output = '';
    outputError = null;
    _notify();
    await loadOutput();
    if (!_disposed) _timers();
  }

  Future<bool> loadOutput() async {
    final id = expanded,
        session = _session,
        scope = _scope,
        read = ++_outputRead;
    if (id == null || session == null) return false;
    try {
      final result = await controller.gateway.request(
        '${sessionPath(session)}/panel/background/${enc(id)}?lines=200',
      );
      if (!_valid(scope) || read != _outputRead || expanded != id) return false;
      final next = '${result['output'] ?? ''}', changed = next != output;
      output = next;
      outputError = null;
      _notify();
      return changed;
    } catch (error) {
      if (_valid(scope) && read == _outputRead) {
        outputError = 'Output unavailable. $error';
        _notify();
      }
      return false;
    }
  }

  Future<void> pressStop(Json task) async {
    if (!controller.canWrite ||
        stopping != null ||
        task['status'] != 'running') {
      return;
    }
    final id = '${task['id']}';
    if (armed != id) {
      armed = id;
      stopError = null;
      _arm?.cancel();
      _arm = Timer(const Duration(seconds: 3), () {
        armed = null;
        _notify();
      });
      _notify();
      return;
    }
    final session = _session,
        scope = _scope,
        generation = controller.control['generation'];
    _arm?.cancel();
    armed = null;
    if (session == null || generation == null) {
      _notify();
      return;
    }
    stopping = id;
    _notify();
    try {
      final result = await controller.gateway.request(
        '${sessionPath(session)}/panel/background/${enc(id)}/stop',
        method: 'POST',
        body: {'clientId': controller.clientId, 'generation': generation},
      );
      if (!_valid(scope)) return;
      final next = obj(result['task']);
      if (next['id'] == id) {
        controller.panelData.updateTask(next);
        data = {
          ...data,
          'backgroundTasks': [
            for (final t in rows(data['backgroundTasks']))
              t['id'] == id ? next : t,
          ],
        };
      }
      if (expanded == id) unawaited(loadOutput());
    } catch (error) {
      if (_valid(scope)) stopError = 'Could not stop the task. $error';
    } finally {
      if (_valid(scope)) {
        stopping = null;
        _timers();
        _notify();
      }
    }
  }

  void toggleFinished() {
    finishedOpen = !finishedOpen;
    _notify();
  }

  void clearFinished() {
    cleared.addAll(finished.map((t) => '${t['id']}'));
    if (cleared.contains(expanded)) {
      ++_outputRead;
      expanded = null;
      _poll?.cancel();
    }
    if (!visible) setOpen(false);
    _notify();
  }

  @override
  void dispose() {
    _disposed = true;
    ++_scope;
    controller.removeListener(_observe);
    controller.panelData.removeListener(_panelUpdated);
    _events?.cancel();
    _refresh?.cancel();
    _poll?.cancel();
    _arm?.cancel();
    _clock?.cancel();
    super.dispose();
  }
}
