import '../l10n/app_i18n.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'package:flutter/foundation.dart';
import 'gateway.dart';

class BrowserState extends ChangeNotifier {
  BrowserState(this.controller) {
    events = controller.gateway.events.listen(event);
    controller.addListener(observe);
    observe();
  }
  final LiveController controller;
  late final StreamSubscription<Json> events;
  String? session, origin, client;
  static int serial = 0;
  String? tag;
  bool disposed = false, active = false, foreground = true, connected = false;
  bool showLog = false, editingUrl = false;
  String notice = '', unavailable = '', urlDraft = '';
  Json? view;
  Uint8List? image, replayImage;
  int width = 1280, height = 800, attempts = 0;
  int? replayIndex;
  List<Json> log = [];
  Timer? retry;
  bool get hasControl => controller.control['held'] == true;
  bool get userMode => view?['mode'] == 'user';
  bool get canDrive => userMode && hasControl;
  bool get valid =>
      !disposed &&
      session == controller.sessionId &&
      origin == controller.origin &&
      client == controller.clientId;
  static final recordingPattern = RegExp(
    r'^Saved recording (\.pirc/recordings/\S+\.webm)$',
  );
  List<String> get recordings => log
      .map((e) => recordingPattern.firstMatch('${e['action']}')?.group(1))
      .whereType<String>()
      .toList();
  void emit() {
    if (!disposed) notifyListeners();
  }

  void observe() {
    if (session != controller.sessionId ||
        origin != controller.origin ||
        client != controller.clientId) {
      disconnect();
      session = controller.sessionId;
      origin = controller.origin;
      client = controller.clientId;
      view = null;
      image = replayImage = null;
      replayIndex = null;
      log = [];
      unavailable = notice = urlDraft = '';
      editingUrl = false;
      attempts = 0;
      unawaited(connect());
    }
    emit();
  }

  void setActive(bool value) {
    active = value;
    if (value) {
      unawaited(connect());
    } else {
      disconnect();
    }
  }

  void setForeground(bool value) {
    foreground = value;
    if (value) {
      unawaited(connect());
    } else {
      disconnect();
    }
  }

  Future<void> close(String value) async {
    try {
      await controller.gateway.call('socketClose', {'tag': value});
    } catch (_) {}
  }

  void disconnect() {
    retry?.cancel();
    connected = false;
    final old = tag;
    tag = null;
    if (old != null) unawaited(close(old));
  }

  Future<void> connect() async {
    if (!valid ||
        session == null ||
        !active ||
        !foreground ||
        tag != null ||
        unavailable.isNotEmpty) {
      return;
    }
    retry?.cancel();
    final ticket = 'native-browser-${++serial}';
    tag = ticket;
    try {
      await controller.gateway.call('socketOpen', {
        'tag': ticket,
        'path': '${sessionPath(session!)}/browser/stream',
      });
      if (!valid || tag != ticket || !active || !foreground) {
        await close(ticket);
      }
    } catch (_) {
      if (valid && tag == ticket) {
        tag = null;
        reconnect();
      }
    }
  }

  void reconnect() {
    connected = false;
    if (!valid || !active || !foreground || unavailable.isNotEmpty) return;
    notice = tr("Reconnecting…");
    emit();
    retry?.cancel();
    retry = Timer(
      Duration(
        milliseconds: math.min(10000, 500 * (1 << attempts.clamp(0, 5))),
      ),
      connect,
    );
    attempts++;
  }

  void event(Json event) {
    final data = obj(event['data']);
    if (!valid || !active || !foreground || tag == null || data['tag'] != tag) {
      return;
    }
    if (event['type'] == 'socketOpened') {
      connected = true;
      attempts = 0;
      notice = '';
      emit();
      return;
    }
    if (event['type'] == 'socketClosed') {
      tag = null;
      connected = false;
      if (data['code'] == 4403) {
        unavailable =
            '${data['message'] ?? 'The browser is not available on this node.'}';
        emit();
      } else {
        reconnect();
      }
      return;
    }
    if (event['type'] != 'socket') return;
    if (!connected) {
      connected = true;
      attempts = 0;
      notice = '';
    }
    final f = obj(data['frame']);
    try {
      switch (f['type']) {
        case 'state':
          view = obj(f['state']);
          if (!editingUrl) urlDraft = '${view!['url'] ?? ''}';
          if (view!['active'] != true) image = null;
        case 'frame':
          final w = (f['width'] as num).toInt(),
              h = (f['height'] as num).toInt();
          if (w <= 0 || h <= 0) return;
          image = base64Decode(f['data']);
          width = w;
          height = h;
        case 'log':
          log = rows(f['entries']);
        case 'log_entry':
          log = [...log.skip(math.max(0, log.length - 149)), obj(f['entry'])];
        case 'log_image':
          if (replayIndex == f['index']) {
            replayImage = f['data'] == null ? null : base64Decode(f['data']);
          }
        case 'error':
          notice = f['code'] == 'lost_control'
              ? 'Take control of the session to use the browser.'
              : f['code'] == 'agent_in_control'
              ? 'Press “Take over” first.'
              : '${f['message']}';
      }
    } catch (_) {
      return;
    } // Ignore malformed stream frames, like the reference.
    emit();
  }

  Future<void> send(Json message) async {
    if (!valid || !connected || !active || !foreground || tag == null) return;
    final ticket = tag;
    try {
      await controller.gateway.call('socketSend', {
        'tag': ticket,
        'data': {
          ...message,
          'clientId': client,
          'generation': controller.control['generation'],
        },
      });
    } catch (_) {
      if (valid && tag == ticket) {
        disconnect();
        reconnect();
      }
    }
  }

  Future<void> act(Json message) async {
    if (!hasControl || controller.control['generation'] == null) {
      notice = tr("Take control of the session to use the browser.");
      emit();
      return;
    }
    await send(message);
  }

  Future<void> navigate() async {
    final url = urlDraft.trim();
    if (url.isEmpty) return;
    editingUrl = false;
    // Capture scope before the sequential bridge calls.
    final ticket = tag;
    if (!userMode) await act({'type': 'takeover'});
    if (valid && tag == ticket) await act({'type': 'navigate', 'url': url});
  }

  void toggleLog() {
    showLog = !showLog;
    emit();
  }

  void openReplay(Json entry) {
    if (entry['image'] != true) return;
    replayIndex = entry['index'];
    replayImage = null;
    emit();
    unawaited(send({'type': 'log_image', 'index': replayIndex}));
  }

  void step(int delta) {
    if (replayIndex == null) return;
    final entries = log.where((e) => e['image'] == true).toList();
    final next = entries.indexWhere((e) => e['index'] == replayIndex) + delta;
    if (next >= 0 && next < entries.length) openReplay(entries[next]);
  }

  void live() {
    replayIndex = null;
    replayImage = null;
    emit();
  }

  Json? get replayEntry =>
      log.where((e) => e['index'] == replayIndex).firstOrNull;
  @override
  void dispose() {
    disconnect();
    disposed = true;
    controller.removeListener(observe);
    events.cancel();
    super.dispose();
  }
}
