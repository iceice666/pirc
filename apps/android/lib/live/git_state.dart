import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'gateway.dart';

class GitRead {
  int revision = 0;
  bool loading = false;
  String? error;
  void abort() {
    revision++;
    loading = false;
    error = null;
  }
}

class GitState extends ChangeNotifier {
  GitState(this.controller) {
    controller.addListener(observe);
    events = controller.gateway.events.listen((e) {
      if (e['sessionId'] == session &&
          e['type'] == 'panelChange' &&
          (e['data'] as List? ?? []).contains('git')) {
        changedOnServer();
      }
    });
    observe();
  }
  final LiveController controller;
  StreamSubscription<Json>? events;
  String? session, origin, client, previousRun;
  bool disposed = false, active = true, stale = false, more = false;
  String view = 'changes';
  Json? status, selected, diff, commit;
  bool selectedStaged = false;
  List<Json> commits = [];
  final statusRead = GitRead(),
      historyRead = GitRead(),
      diffRead = GitRead(),
      commitRead = GitRead();
  List<GitRead> get readers => [statusRead, historyRead, diffRead, commitRead];
  List<Json> get files => status?['repo'] == true ? rows(status?['files']) : [];
  List<Json> get staged =>
      files.where((f) => f['index'] != ' ' && f['index'] != '?').toList();
  List<Json> get unstaged => files.where((f) => f['worktree'] != ' ').toList();
  String? get listError =>
      statusRead.error ?? historyRead.error ?? commitRead.error;
  void emit() {
    if (!disposed) notifyListeners();
  }

  void observe() {
    final c = controller,
        run = obj(controller.state['run'])['status'] as String?;
    if (session != c.sessionId || origin != c.origin || client != c.clientId) {
      for (final r in readers) {
        r.abort();
      }
      session = c.sessionId;
      origin = c.origin;
      client = c.clientId;
      status = null;
      selected = null;
      diff = null;
      commit = null;
      commits = [];
      more = false;
      stale = false;
      previousRun = run;
      if (session != null) {
        unawaited(load());
      } else {
        emit();
      }
      return;
    }
    if (previousRun == 'running' && run != 'running') changedOnServer();
    previousRun = run;
  }

  void changedOnServer() {
    if (active) {
      unawaited(load());
    } else {
      stale = true;
    }
  }

  void setActive(bool value) {
    active = value;
    if (active && stale) unawaited(load());
  }

  Future<Json?> read(GitRead slot, String suffix, String failure) async {
    final id = session,
        server = origin,
        account = client,
        ticket = ++slot.revision;
    if (id == null || disposed) return null;
    bool valid() =>
        !disposed &&
        ticket == slot.revision &&
        id == controller.sessionId &&
        server == controller.origin &&
        account == controller.clientId;
    slot.loading = true;
    slot.error = null;
    emit();
    try {
      final result = await controller.gateway.request(
        '${sessionPath(id)}/git/$suffix',
      );
      return valid() ? result : null;
    } catch (e) {
      if (valid()) {
        slot.error = e is PlatformException && e.message != null
            ? e.message
            : e is StateError
            ? e.message
            : e is Exception
            ? e.toString().replaceFirst(RegExp(r'^Exception: '), '')
            : failure;
      }
      return null;
    } finally {
      if (valid()) {
        slot.loading = false;
        emit();
      }
    }
  }

  Future<void> load() async {
    stale = false;
    final result = await read(
      statusRead,
      'status',
      'Unable to read Git status.',
    );
    if (result == null) return;
    status = result;
    emit();
    if (view == 'history' && status?['repo'] == true) {
      unawaited(refreshHistory());
    }
    if (selected != null) {
      unawaited(openDiff(selected!, selectedStaged, reset: false));
    }
  }

  Future<void> loadHistory({bool reset = false}) async {
    final result = await read(
      historyRead,
      'log?skip=${reset ? 0 : commits.length}&limit=50',
      'Unable to load history.',
    );
    if (result == null) return;
    commits = reset
        ? rows(result['commits'])
        : [...commits, ...rows(result['commits'])];
    more = result['more'] == true;
    emit();
  }

  Future<void> refreshHistory() async {
    if (commits.isEmpty) return loadHistory(reset: true);
    final result = await read(
      historyRead,
      'log?skip=0&limit=50',
      'Unable to load history.',
    );
    if (result == null) return;
    final page = rows(result['commits']),
        overlap = rows(
          result['commits'],
        ).indexWhere((c) => c['sha'] == commits.first['sha']);
    if (overlap < 0) {
      commits = page;
      more = result['more'] == true;
    } else if (overlap > 0) {
      commits = [...page.take(overlap), ...commits];
    }
    emit();
  }

  Future<void> openDiff(Json file, bool staged, {bool reset = true}) async {
    selected = file;
    selectedStaged = staged;
    if (reset) diff = null;
    emit();
    final result = await read(
      diffRead,
      'diff?path=${enc('${file['path']}')}${staged ? '&staged=1' : ''}${file['worktree'] == '?' ? '&untracked=1' : ''}',
      'Unable to load diff.',
    );
    if (result != null) {
      diff = result;
      emit();
    }
  }

  Future<void> openCommit(Json item) async {
    commit = null;
    emit();
    final result = await read(
      commitRead,
      'commits/${enc('${item['sha']}')}',
      'Unable to load commit.',
    );
    if (result != null) {
      commit = result;
      emit();
    }
  }

  void back() {
    diffRead.abort();
    commitRead.abort();
    selected = null;
    commit = null;
    emit();
  }

  Future<void> switchView(String next) async {
    view = next;
    back();
    if (next == 'history' && status?['repo'] == true && commits.isEmpty) {
      await loadHistory(reset: true);
    }
  }

  @override
  void dispose() {
    disposed = true;
    for (final r in readers) {
      r.abort();
    }
    unawaited(events?.cancel());
    controller.removeListener(observe);
    super.dispose();
  }
}
