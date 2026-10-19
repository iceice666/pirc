import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import '../document_navigation_widget_test.dart' show DocumentGateway;

/// Uses the actual JS runtime and Dart host with a local VM protocol peer.
/// Only HTTP/Android IPC are controlled; no DOM snapshots are fabricated.
class DocumentVmGateway extends DocumentGateway {
  DocumentVmGateway._(this.process) {
    process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(
          (line) {
            final message = Map<String, dynamic>.from(jsonDecode(line) as Map);
            final pending = _pending.remove(message['sequence']);
            if (pending == null) return;
            if (message['error'] != null) {
              pending.completeError(StateError(message['error'] as String));
            } else {
              pending.complete(message['result']);
            }
          },
          onError: _fail,
          onDone: () => _fail(StateError('Document VM protocol closed.')),
        );
    process.stderr.transform(utf8.decoder).listen((data) {
      if (stderr.length < 8192) stderr.write(data);
    });
  }
  static Future<DocumentVmGateway> start() async => DocumentVmGateway._(
    await Process.start(Platform.environment['PIRC_TEST_NODE'] ?? 'node', [
      'tool/parity/document_vm_host.mjs',
    ]),
  );
  final Process process;
  final stderr = StringBuffer();
  final _pending = <int, Completer<dynamic>>{};
  final _owners = <int, String>{};
  final requests = <String, Json>{};
  final resources = <String, Completer<Json>>{};
  Completer<dynamic>? picker;
  int pickerCalls = 0;
  final cancellations = <String>[];
  int _next = 0, opens = 0, closes = 0;
  void _fail(Object error) {
    for (final c in _pending.values) {
      if (!c.isCompleted) c.completeError(error);
    }
    _pending.clear();
  }

  Future<dynamic> _rpc(String method, Json args) {
    final sequence = ++_next, c = Completer<dynamic>();
    _pending[sequence] = c;
    process.stdin.writeln(
      jsonEncode({'sequence': sequence, 'method': method, 'args': args}),
    );
    return c.future;
  }

  @override
  Future<dynamic> call(String method, [Json args = const {}]) async {
    switch (method) {
      case 'pickAttachments':
        pickerCalls++;
        return picker?.future;
      case 'documentScriptCapabilities':
        return {'supported': true};
      case 'documentScriptOpen':
        final result = obj(await _rpc('open', args));
        opens++;
        _owners[result['id'] as int] = args['owner'] as String;
        return result;
      case 'documentScriptEvaluate':
        return _rpc('evaluate', args);
      case 'documentScriptClose':
        final result = await _rpc('close', args);
        closes++;
        _owners.remove(args['id']);
        return result;
      case 'documentScriptResource':
        final request = obj(args['request']);
        final id = request['id'] as String;
        requests[id] = request;
        final pending = Completer<Json>();
        resources[id] = pending;
        return pending.future;
      case 'documentScriptResourceCancel':
        final id = args['requestId'] as String;
        cancellations.add(id);
        final pending = resources[id];
        if (pending != null && !pending.isCompleted) {
          pending.completeError(StateError('synthetic transport cancellation'));
        }
        return null;
      default:
        return super.call(method, args);
    }
  }

  void respond(String id, String body, {int status = 200}) {
    final pending = resources[id]!;
    if (pending.isCompleted) return;
    pending.complete({
      'url': requests[id]!['url'],
      'status': status,
      'statusText': 'OK',
      'headers': {'content-type': 'application/json'},
      'type': 'basic',
      'redirected': false,
      'bodyBytes': utf8.encode(body),
    });
  }

  Future<dynamic> inspect(String expression) async {
    final id = _owners.keys.single;
    final reply = obj(
      await _rpc('evaluate', {
        'id': id,
        'owner': _owners[id],
        'source': 'JSON.stringify($expression)',
      }),
    );
    return jsonDecode(reply['value'] as String);
  }

  Future<void> close() async {
    // Tests dispose their documents first; close stdin to stop the isolated peer.
    await process.stdin.close();
    final code = await process.exitCode.timeout(
      const Duration(seconds: 5),
      onTimeout: () {
        process.kill();
        throw TimeoutException('Document VM peer failed to close.');
      },
    );
    if (code != 0) throw StateError('Document VM exit $code: $stderr');
  }
}

/// Real process I/O is outside the widget fake clock. Pump the actual native
/// frames between bounded I/O yields; no synthetic geometry packets are used.
Future<void> driveDocumentVm(
  WidgetTester t,
  bool Function() ready, {
  String reason = 'document VM',
  String Function()? diagnostic,
}) async {
  for (var i = 0; i < 400; i++) {
    await t.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 3)),
    );
    await t.pump(const Duration(milliseconds: 16));
    if (ready()) return;
    final error = t.takeException();
    if (error != null) throw TestFailure('$reason: $error');
  }
  throw TestFailure('Timed out waiting for $reason: ${diagnostic?.call()}');
}
