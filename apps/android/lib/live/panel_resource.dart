import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'gateway.dart';

/// Shared session panel snapshot, matching the pinned PanelStateResource.
class PanelResource extends ChangeNotifier {
  PanelResource(this.controller) {
    controller.addListener(observe);
    observe();
  }
  final LiveController controller;
  Json? value;
  String? error;
  String? session, origin, client;
  int epoch = 0, mutation = 0;
  bool disposed = false, again = false;
  Future<void>? pending;
  Timer? timer;
  void observe() {
    if (session == controller.sessionId &&
        origin == controller.origin &&
        client == controller.clientId) {
      return;
    }
    epoch++;
    session = controller.sessionId;
    origin = controller.origin;
    client = controller.clientId;
    value = null;
    error = null;
    pending = null;
    again = false;
    timer?.cancel();
    timer = null;
    if (!disposed) notifyListeners();
  }

  bool valid(int scope) =>
      !disposed &&
      scope == epoch &&
      session == controller.sessionId &&
      origin == controller.origin &&
      client == controller.clientId;
  Future<void> refresh({bool fresh = false}) {
    if (disposed) return Future.value();
    observe();
    final id = session;
    if (id == null) return Future.value();
    if (pending != null) {
      if (fresh) again = true;
      return pending!;
    }
    final scope = epoch, version = mutation;
    Future<void> run() async {
      try {
        final next = await controller.gateway.request(
          '${sessionPath(id)}/panel/state',
        );
        if (!valid(scope) || version != mutation) return;
        value = next;
        error = null;
      } catch (e) {
        if (!valid(scope)) return;
        error = e is PlatformException && e.message != null
            ? e.message
            : LiveController.describe(e);
      } finally {
        if (valid(scope)) {
          pending = null;
          notifyListeners();
          if (again) {
            again = false;
            unawaited(refresh());
          }
        }
      }
    }

    return pending = run();
  }

  void schedule([int delay = 400]) {
    if (disposed || timer != null) return;
    timer = Timer(Duration(milliseconds: delay), () {
      timer = null;
      unawaited(refresh(fresh: true));
    });
  }

  void updateTask(Json task) {
    if (disposed || value == null) return;
    mutation++;
    // A pre-action GET must not roll a confirmed stop back to running.
    if (pending != null) again = true;
    value = {
      ...value!,
      'backgroundTasks': [
        for (final t in rows(value!['backgroundTasks']))
          t['id'] == task['id'] ? task : t,
      ],
    };
    notifyListeners();
  }

  @override
  void dispose() {
    disposed = true;
    epoch++;
    timer?.cancel();
    controller.removeListener(observe);
    super.dispose();
  }
}
