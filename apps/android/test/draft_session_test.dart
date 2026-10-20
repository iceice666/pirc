import 'dart:async';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'live_test.dart' show FakeGateway;

void main() {
  Future<(LiveController, FakeGateway)> setup() async {
    final g = FakeGateway();
    final c = LiveController(g);
    await c.boot();
    g.calls.clear();
    return (c, g);
  }

  test('new session is local, replacement and departure discard it', () async {
    final (c, g) = await setup();
    await c.create('w');
    final first = c.sessionId;
    c.editDraft('not sent');
    await c.flushDraft();
    expect(c.revealSelectedSession, true);
    expect(c.title, 'New session');
    expect(c.sessions.any((s) => s['id'] == first), false);
    expect(
      g.calls.where(
        (call) => call.$1 == 'draft' && call.$2['sessionId'] == first,
      ),
      isEmpty,
    );
    await c.create('w');
    expect(c.sessionId, isNot(first));
    expect(c.draft, '');
    await c.home();
    expect(c.isDraftSession, false);
    expect(
      g.calls.where(
        (call) => call.$1 == 'request' && call.$2['method'] == 'POST',
      ),
      isEmpty,
    );
    c.dispose();
    await g.stream.close();
  });

  test(
    'first send creates once, obtains control, uploads and sends chosen model',
    () async {
      final (c, g) = await setup();
      var creates = 0;
      g.handler = (method, args) async {
        if (method == 'request' && args['method'] == 'POST') {
          creates++;
          return {
            'session': {
              'id': 'created',
              'workspaceId': 'w',
              'name': 'New session',
            },
          };
        }
        if (method == 'watch') {
          g.stream.add({
            'type': 'connection',
            'sessionId': 'created',
            'data': 'live',
          });
        }
        if (method == 'pickAttachments') {
          return [
            {
              'name': 'note.txt',
              'bytes': Uint8List.fromList([65]),
              'mimeType': 'text/plain',
            },
          ];
        }
        if (method == 'uploadAttachment') {
          return {'id': 'upload1', 'name': 'note.txt'};
        }
        return g.normal(method, args);
      };
      await c.create('w');
      await c.attach();
      expect(g.calls.where((call) => call.$1 == 'uploadAttachment'), isEmpty);
      c.editDraft('hello');
      await Future.wait([c.send('prompt'), c.send('prompt')]);
      expect(creates, 1);
      expect(c.sessionId, 'created');
      expect(c.isDraftSession, false);
      final sent = g.calls
          .where((call) => call.$1 == 'command')
          .map((call) => obj(call.$2['payload']))
          .toList();
      expect(sent.last['type'], 'prompt');
      expect(sent.last['uploadIds'], ['upload1']);
      expect(c.draft, '');
      expect(c.attachments, isEmpty);
      c.dispose();
      await g.stream.close();
    },
  );

  test(
    'first send waits for a delayed stream and still sends exactly once',
    () async {
      final (c, g) = await setup();
      final watching = Completer<void>();
      g.handler = (method, args) async {
        if (method == 'request' && args['method'] == 'POST') {
          return {
            'session': {
              'id': 'created',
              'workspaceId': 'w',
              'name': 'New session',
            },
          };
        }
        if (method == 'watch' && args['sessionId'] == 'created') {
          watching.complete();
        }
        return g.normal(method, args);
      };
      await c.create('w');
      c.editDraft('first message');
      final send = c.send('prompt');
      await watching.future;
      await Future<void>.delayed(Duration.zero);
      expect(g.calls.where((call) => call.$1 == 'command'), isEmpty);
      expect(c.busy, true);
      g.stream.add({
        'type': 'connection',
        'sessionId': 'created',
        'data': 'live',
      });
      await send;
      expect(
        g.calls.where(
          (call) =>
              call.$1 == 'command' &&
              obj(call.$2['payload'])['type'] == 'prompt',
        ),
        hasLength(1),
      );
      expect(c.draft, '');
      c.dispose();
      await g.stream.close();
    },
  );

  test('failed creation keeps the local draft and can retry', () async {
    final (c, g) = await setup();
    g.handler = (method, args) async {
      if (method == 'request' && args['method'] == 'POST') {
        throw StateError('offline');
      }
      return g.normal(method, args);
    };
    await c.create('w');
    c.editDraft('keep me');
    await c.send('prompt');
    expect(c.isDraftSession, true);
    expect(c.draft, 'keep me');
    expect(c.busy, false);
    expect(c.actionError, 'offline');
    c.dispose();
    await g.stream.close();
  });
}
