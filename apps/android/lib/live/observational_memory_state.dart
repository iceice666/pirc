import 'dart:async';
import 'package:flutter/foundation.dart';
import 'gateway.dart';

String memoryTokens(num value) => value >= 10000
    ? '${(value / 1000).round()}k'
    : value >= 1000
    ? '${(value / 1000).toStringAsFixed(1)}k'
    : value == value.roundToDouble()
    ? '${value.toInt()}'
    : '$value';

class ObservationalMemoryState extends ChangeNotifier {
  ObservationalMemoryState(this.controller) {
    controller.addListener(observe);
    controller.panelData.addListener(changed);
    events = controller.gateway.events.listen((event) {
      if (active &&
          event['sessionId'] == controller.sessionId &&
          event['type'] == 'panelChange' &&
          (event['data'] as List? ?? []).contains('memory')) {
        controller.panelData.schedule();
      }
    });
    observe();
  }
  final LiveController controller;
  StreamSubscription<Json>? events;
  bool active = false, disposed = false;
  String? session, origin, client, previousRun;
  String filter = 'active';
  final expanded = <String>{};
  Json? get memory => controller.panelData.value?['memory'] == null
      ? null
      : obj(controller.panelData.value?['memory']);
  Json get runtime => obj(controller.panelData.value?['memoryRuntime']);
  List<Json> get observations => rows(memory?['observations'])
      .where(
        (o) =>
            filter == 'all' ||
            (filter == 'dropped' ? o['dropped'] == true : o['dropped'] != true),
      )
      .toList()
      .reversed
      .toList();
  List<Json> get reflections => rows(memory?['reflections']).reversed.toList();
  void changed() {
    if (!disposed) notifyListeners();
  }

  void observe() {
    final c = controller;
    if (session != c.sessionId || origin != c.origin || client != c.clientId) {
      session = c.sessionId;
      origin = c.origin;
      client = c.clientId;
      if (active) unawaited(c.panelData.refresh());
    }
    final run = obj(c.state['run'])['status'] as String?;
    if (active && previousRun == 'running' && run != 'running') {
      c.panelData.schedule(100);
    }
    previousRun = run;
    changed();
  }

  void setActive(bool value) {
    if (active == value) return;
    active = value;
    if (active) unawaited(controller.panelData.refresh());
  }

  void setFilter(String value) {
    filter = value;
    changed();
  }

  void toggle(String id) {
    if (!expanded.remove(id)) expanded.add(id);
    changed();
  }

  @override
  void dispose() {
    disposed = true;
    unawaited(events?.cancel());
    controller.removeListener(observe);
    controller.panelData.removeListener(changed);
    super.dispose();
  }
}
