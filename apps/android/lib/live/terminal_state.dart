import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'terminal_input.dart';
import 'gateway.dart';

String terminalError(Object error, String fallback) => switch (error) {
  PlatformException(:final message) => message ?? fallback,
  StateError(:final message) => message,
  Exception() => error.toString().replaceFirst(RegExp(r'^Exception: '), ''),
  _ => fallback,
};

class TerminalPaneState extends ChangeNotifier {
  TerminalPaneState(this.controller) {
    controller.addListener(observe);
    observe();
  }
  final LiveController controller;
  String? session, origin, client, current;
  String error = '', listError = '';
  List<Json> terminals = [];
  bool busy = false, disposed = false;
  int epoch = 0, listRevision = 0;
  final closing = <String>{};
  bool get hasControl => controller.control['held'] == true;
  dynamic get generation => controller.control['generation'];
  bool valid(int e) =>
      !disposed &&
      e == epoch &&
      session == controller.sessionId &&
      origin == controller.origin &&
      client == controller.clientId;
  void emit() {
    if (!disposed) notifyListeners();
  }

  void observe() {
    if (session != controller.sessionId ||
        origin != controller.origin ||
        client != controller.clientId) {
      epoch++;
      session = controller.sessionId;
      origin = controller.origin;
      client = controller.clientId;
      terminals = [];
      current = null;
      error = listError = '';
      busy = false;
      closing.clear();
      if (session != null) unawaited(load());
    }
    emit();
  }

  Future<void> load() async {
    final e = epoch, revision = ++listRevision, id = session;
    if (id == null) return;
    listError = '';
    try {
      final data = await controller.gateway.request(
        '${sessionPath(id)}/terminals',
      );
      if (!valid(e) || revision != listRevision) return;
      terminals = rows(data['terminals']);
      if (!terminals.any((t) => t['id'] == current)) {
        current = terminals.lastOrNull?['id'];
      }
    } catch (e2) {
      if (valid(e) && revision == listRevision) {
        listError = terminalError(e2, 'Terminals are unavailable.');
      }
    }
    if (valid(e)) emit();
  }

  void select(String id) {
    current = id;
    emit();
  }

  Future<void> create() async {
    if (busy || session == null) return;
    if (!hasControl || generation == null) {
      error = 'Take control of the session to open a terminal.';
      emit();
      return;
    }
    final e = epoch, id = session!;
    busy = true;
    error = '';
    listRevision++;
    emit();
    try {
      final data = await controller.gateway.request(
        '${sessionPath(id)}/terminals',
        method: 'POST',
        body: {
          'clientId': client,
          'generation': generation,
          'cols': 80,
          'rows': 24,
        },
      );
      if (!valid(e)) return;
      final terminal = obj(data['terminal']);
      terminals = [...terminals.where((t) => t['exited'] != true), terminal];
      current = terminal['id'];
    } catch (e2) {
      if (valid(e)) error = terminalError(e2, 'Unable to open a terminal.');
    } finally {
      if (valid(e)) {
        busy = false;
        emit();
      }
    }
  }

  Future<void> close(Json terminal) async {
    final e = epoch, id = '${terminal['id']}', owner = session;
    if (owner == null || closing.contains(id)) return;
    if (terminal['exited'] != true && (!hasControl || generation == null)) {
      error = 'Take control of the session to close a terminal.';
      emit();
      return;
    }
    closing.add(id);
    try {
      if (terminal['exited'] != true) {
        await controller.gateway.request(
          '${sessionPath(owner)}/terminals/${enc(id)}/close',
          method: 'POST',
          body: {'clientId': client, 'generation': generation},
        );
      }
    } catch (e2) {
      if (!valid(e)) return;
      final message = terminalError(e2, 'Unable to close the terminal.');
      if (!RegExp('not found', caseSensitive: false).hasMatch(message)) {
        error = message;
        emit();
        return;
      }
    } finally {
      if (valid(e)) closing.remove(id);
    }
    if (!valid(e)) return;
    listRevision++;
    terminals = terminals.where((t) => t['id'] != id).toList();
    if (current == id) current = terminals.lastOrNull?['id'];
    emit();
  }

  void exited(String id, int? code) {
    terminals = [
      for (final t in terminals)
        t['id'] == id ? {...t, 'exited': true, 'exitCode': code} : t,
    ];
    emit();
  }

  @override
  void dispose() {
    disposed = true;
    epoch++;
    controller.removeListener(observe);
    super.dispose();
  }
}

/// One PTY connection, retained across terminal/side-panel switches.
class NativeTerminalSession extends ChangeNotifier {
  NativeTerminalSession(this.controller, this.info, {required this.onExit})
    : session = controller.sessionId!,
      origin = controller.origin,
      client = controller.clientId,
      exited = info['exited'] == true {
    terminal = makeTerminal();
    subscription = controller.gateway.events.listen(frame);
    controller.addListener(controlChanged);
    held = controller.control['held'] == true;
    controlGeneration = controller.control['generation'];
    unawaited(connect());
  }
  final LiveController controller;
  final Json info;
  final String session;
  final String? origin, client;
  final void Function(int?) onExit;
  late NativeTerminalInput terminal;
  late final StreamSubscription<Json> subscription;
  static int serial = 0;
  String tag = '';
  String notice = '', sentSize = '';
  bool exited,
      ready = false,
      disposed = false,
      foreground = true,
      visible = false,
      held = false;
  int attempts = 0;
  dynamic controlGeneration;
  Timer? retry, resizeTimer;
  bool get valid =>
      !disposed &&
      session == controller.sessionId &&
      origin == controller.origin &&
      client == controller.clientId;
  NativeTerminalInput makeTerminal() => NativeTerminalInput(
    onModifiersChanged: emit,
    onOutput: input,
    onResize: (_, _, _, _) => scheduleResize(),
  );
  void emit() {
    if (!disposed) notifyListeners();
  }

  Future<void> connect() async {
    if (!valid || exited || !foreground) return;
    retry?.cancel();
    ready = false;
    final old = tag;
    tag = 'native-terminal-${++serial}';
    final ticket = tag;
    if (old.isNotEmpty) unawaited(closeSocket(old));
    try {
      await controller.gateway.call('socketOpen', {
        'tag': ticket,
        'path':
            '${sessionPath(session)}/terminals/${enc('${info['id']}')}/stream',
      });
      if (!valid || ticket != tag || !foreground) await closeSocket(ticket);
    } catch (e) {
      if (valid && ticket == tag) reconnect();
    }
  }

  Future<void> closeSocket(String value) async {
    try {
      await controller.gateway.call('socketClose', {'tag': value});
    } catch (_) {
      /* A disposed bridge already closed its sockets. */
    }
  }

  void reconnect() {
    if (!valid || exited || !foreground) return;
    ready = false;
    notice = 'Reconnecting…';
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

  void frame(Json event) {
    final data = obj(event['data']);
    if (!valid || !foreground || data['tag'] != tag) return;
    if (event['type'] == 'socketClosed') {
      ready = false;
      if (data['code'] == 4404) {
        exited = true;
        notice = 'This terminal no longer exists.';
        retry?.cancel();
        onExit(null);
        emit();
      } else {
        reconnect();
      }
      return;
    }
    if (event['type'] != 'socket') return;
    final message = obj(data['frame']);
    switch (message['type']) {
      case 'ready':
        attempts = 0;
        ready = true;
        notice = '';
        retry?.cancel();
        final width = terminal.viewWidth, height = terminal.viewHeight;
        terminal = makeTerminal()
          ..resize(width, height)
          ..write('${message['replay'] ?? ''}');
        sentSize = '';
        scheduleResize();
        emit();
      case 'output':
        terminal.write('${message['data'] ?? ''}');
      case 'exit':
        exited = true;
        retry?.cancel();
        final code = message['exitCode'] as int?;
        terminal.write(
          '\r\n\x1b[2m[process exited${code == null ? '' : ' with code $code'}]\x1b[0m\r\n',
        );
        onExit(code);
        emit();
      case 'error':
        if (message['code'] == 'lost_control') {
          notice = 'Take control of the session to type here.';
          emit();
        }
    }
  }

  void input(String data) {
    if (controller.control['held'] != true) {
      notice = 'Take control of the session to type here.';
      emit();
      return;
    }
    unawaited(send({'type': 'input', 'data': data}));
  }

  Future<void> send(Json data) async {
    if (!valid ||
        !foreground ||
        !ready ||
        exited ||
        controller.control['held'] != true ||
        controller.control['generation'] == null) {
      return;
    }
    final ticket = tag;
    try {
      await controller.gateway.call('socketSend', {
        'tag': ticket,
        'data': {
          ...data,
          'clientId': client,
          'generation': controller.control['generation'],
        },
      });
    } catch (_) {
      if (valid && ticket == tag) reconnect();
    }
  }

  void scheduleResize() {
    resizeTimer?.cancel();
    resizeTimer = Timer(const Duration(milliseconds: 50), () {
      if (!valid ||
          !visible ||
          !foreground ||
          !ready ||
          exited ||
          controller.control['held'] != true ||
          controller.control['generation'] == null) {
        return;
      }
      final size = '${terminal.viewWidth}x${terminal.viewHeight}';
      if (size == sentSize) return;
      sentSize = size;
      unawaited(
        send({
          'type': 'resize',
          'cols': terminal.viewWidth,
          'rows': terminal.viewHeight,
        }),
      );
    });
  }

  void setVisible(bool value) {
    if (visible == value) return;
    visible = value;
    if (value) scheduleResize();
  }

  void controlChanged() {
    if (!valid) {
      retry?.cancel();
      resizeTimer?.cancel();
      ready = false;
      if (tag.isNotEmpty) unawaited(closeSocket(tag));
      return;
    }
    final value = controller.control['held'] == true;
    final generation = controller.control['generation'];
    if (value == held && generation == controlGeneration) return;
    if (value && (!held || generation != controlGeneration)) {
      if (notice.startsWith('Take control')) notice = '';
      sentSize = '';
      scheduleResize();
    }
    if (!value || generation != controlGeneration) {
      terminal.clearModifiers(notify: false);
    }
    held = value;
    controlGeneration = generation;
    emit();
  }

  void setForeground(bool value) {
    if (foreground == value) return;
    foreground = value;
    if (value) {
      unawaited(connect());
    } else {
      retry?.cancel();
      resizeTimer?.cancel();
      ready = false;
      if (tag.isNotEmpty) unawaited(closeSocket(tag));
    }
  }

  @override
  void dispose() {
    disposed = true;
    retry?.cancel();
    resizeTimer?.cancel();
    subscription.cancel();
    controller.removeListener(controlChanged);
    if (tag.isNotEmpty) unawaited(closeSocket(tag));
    super.dispose();
  }
}
