import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'gateway.dart';

class TasksState extends ChangeNotifier {
  TasksState(this.controller) {
    controller.addListener(observe);
    controller.panelData.addListener(panelChanged);
    events = controller.gateway.events.listen((e) {
      if (active &&
          e['sessionId'] == session &&
          e['type'] == 'panelChange' &&
          (e['data'] as List? ?? []).any(
            (s) => s == 'background' || s == 'team',
          )) {
        controller.panelData.schedule();
      }
    });
    observe();
  }
  final LiveController controller;
  StreamSubscription<Json>? events;
  String? session, origin, client, previousRun, liveStatus;
  bool active = false, disposed = false, outputLoading = false;
  int scope = 0, outputRead = 0, outputRevision = 0;
  Json? selected;
  String output = '';
  String? outputError;
  Json? get data => controller.panelData.value;
  List<Json> get tasks => rows(data?['backgroundTasks']).reversed.toList();
  List<Json> get agents => rows(obj(data?['team'])['agents']);
  List<Json> get teammates =>
      agents.where((a) => a['mode'] != 'subagent').toList();
  List<Json> get subagents =>
      agents.where((a) => a['mode'] == 'subagent').toList().reversed.toList();
  List<Json> get board => rows(obj(data?['team'])['tasks']);
  List<Json> get activity =>
      rows(obj(data?['team'])['events']).reversed.take(12).toList();
  void emit() {
    if (!disposed) notifyListeners();
  }

  void observe() {
    final c = controller;
    if (session != c.sessionId || origin != c.origin || client != c.clientId) {
      ++scope;
      ++outputRead;
      session = c.sessionId;
      origin = c.origin;
      client = c.clientId;
      selected = null;
      output = '';
      outputError = null;
      outputLoading = false;
      liveStatus = null;
      if (active) unawaited(c.panelData.refresh());
    }
    final run = obj(c.state['run'])['status'] as String?;
    if (active && previousRun == 'running' && run != 'running') {
      c.panelData.schedule(100);
    }
    previousRun = run;
    emit();
  }

  void panelChanged() {
    if (disposed) return;
    final current = tasks.where((t) => t['id'] == selected?['id']).firstOrNull;
    final status = current == null
        ? null
        : '${current['id']}\n${current['status']}';
    final before = liveStatus;
    liveStatus = status;
    if (status != null &&
        before != null &&
        before != status &&
        before.split('\n').first == status.split('\n').first) {
      unawaited(refreshOutput());
    }
    emit();
  }

  void setActive(bool value) {
    if (active == value) return;
    active = value;
    if (active) unawaited(controller.panelData.refresh());
  }

  Future<void> open(Json task) async {
    selected = task;
    output = '';
    outputError = null;
    liveStatus = '${task['id']}\n${task['status']}';
    emit();
    await refreshOutput();
  }

  Future<void> refreshOutput() async {
    final id = session, task = selected?['id'];
    if (id == null || task == null || disposed) return;
    final epoch = scope, read = ++outputRead;
    bool valid() =>
        !disposed &&
        scope == epoch &&
        read == outputRead &&
        session == controller.sessionId &&
        origin == controller.origin &&
        client == controller.clientId &&
        selected?['id'] == task;
    outputLoading = true;
    outputError = null;
    emit();
    try {
      final result = await controller.gateway.request(
        '${sessionPath(id)}/panel/background/${enc('$task')}?lines=400',
      );
      if (!valid()) return;
      selected = obj(result['task']);
      output = '${result['output'] ?? ''}';
      outputRevision++;
    } catch (e) {
      if (valid()) {
        outputError = e is PlatformException && e.message != null
            ? e.message
            : LiveController.describe(e);
      }
    } finally {
      if (valid()) {
        outputLoading = false;
        emit();
      }
    }
  }

  void back() {
    ++outputRead;
    selected = null;
    liveStatus = null;
    outputLoading = false;
    emit();
  }

  @override
  void dispose() {
    disposed = true;
    scope++;
    unawaited(events?.cancel());
    controller.removeListener(observe);
    controller.panelData.removeListener(panelChanged);
    super.dispose();
  }
}
