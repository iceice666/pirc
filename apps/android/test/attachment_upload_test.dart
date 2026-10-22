import 'dart:async';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'live_test.dart' show FakeGateway;

Json file(String name, {String mime = 'image/png'}) => {
  'name': name,
  'mimeType': mime,
  'bytes': Uint8List.fromList([1, 2, 3]),
};
Future<void> flush() => Future<void>.delayed(Duration.zero);

void main() {
  test(
    'multiple attachments show sequential pending state and send only server IDs',
    () async {
      final g = FakeGateway();
      final c = LiveController(g, showing: 'engine')..sessionId = 's';
      final first = Completer<Json>(), second = Completer<Json>();
      g.handler = (method, args) async {
        if (method == 'pickAttachments') {
          return [file('first.png'), file('second.txt', mime: 'text/plain')];
        }
        if (method == 'uploadAttachment') {
          return args['name'] == 'first.png' ? first.future : second.future;
        }
        return g.normal(method, args);
      };
      final uploading = c.attach();
      await flush();
      expect(c.uploading, true);
      expect(c.attachments.single['uploading'], true);
      expect(c.attachments.single['previewBytes'], isA<Uint8List>());
      c.draft = 'send';
      c.connection = 'live';
      c.control = {'held': true};
      await c.send('prompt');
      expect(g.calls.where((v) => v.$1 == 'command'), isEmpty);
      first.complete({'id': 'one', 'name': 'first.png', 'kind': 'image'});
      await flush();
      expect(c.attachments.length, 2);
      expect(c.attachments.first['id'], 'one');
      expect(c.attachments.last['uploading'], true);
      expect(c.attachments.last.containsKey('previewBytes'), false);
      second.complete({'id': 'two', 'name': 'second.txt', 'kind': 'file'});
      await uploading;
      expect(c.uploading, false);
      await c.send('prompt');
      final command =
          g.calls.lastWhere((v) => v.$1 == 'command').$2['payload'] as Json;
      expect(command['uploadIds'], ['one', 'two']);
      expect(command.containsKey('previewBytes'), false);
      expect(c.attachments, isEmpty);
      c.dispose();
      await g.stream.close();
    },
  );

  test(
    'read/upload failure preserves earlier files and continues remaining files',
    () async {
      final g = FakeGateway();
      final c = LiveController(g, showing: 'engine')..sessionId = 's';
      c.attachments.add({
        'id': 'existing',
        'name': 'existing.txt',
        'kind': 'file',
      });
      g.handler = (method, args) async {
        if (method == 'pickAttachments') {
          return [
            {'name': 'unreadable', 'error': 'Permission denied'},
            file('bad.png'),
            file('good.png'),
          ];
        }
        if (method == 'uploadAttachment') {
          if (args['name'] == 'bad.png') {
            throw PlatformException(
              code: 'UPLOAD',
              message: 'Could not upload bad.png.',
            );
          }
          return {'id': 'good', 'name': 'good.png', 'kind': 'image'};
        }
        return g.normal(method, args);
      };
      await c.attach();
      expect(c.attachments.map((a) => a['id']), ['existing', 'good']);
      expect(c.actionError, 'Could not upload bad.png.');
      expect(c.uploading, false);
      c.dispose();
      await g.stream.close();
    },
  );

  test('cancelled picker preserves existing attachments', () async {
    final g = FakeGateway();
    final c = LiveController(g, showing: 'engine')..sessionId = 's';
    c.attachments.add({'id': 'existing'});
    g.handler = (method, args) async =>
        method == 'pickAttachments' ? null : g.normal(method, args);
    await c.attach();
    expect(c.attachments.single['id'], 'existing');
    expect(c.uploading, false);
    expect(c.actionError, isNull);
    c.dispose();
    await g.stream.close();
  });

  test(
    'switch away and back discards old completion and does not upload remaining files',
    () async {
      final g = FakeGateway();
      final c = LiveController(g, showing: 'engine')..sessionId = 's';
      final pending = Completer<Json>();
      g.handler = (method, args) async {
        if (method == 'pickAttachments') {
          return [file('old.png'), file('never.png')];
        }
        if (method == 'uploadAttachment') return pending.future;
        return g.normal(method, args);
      };
      final work = c.attach();
      await flush();
      await c.open('other');
      await c.open('s');
      pending.complete({'id': 'old', 'name': 'old.png', 'kind': 'image'});
      await work;
      expect(c.attachments, isEmpty);
      expect(g.calls.where((v) => v.$1 == 'uploadAttachment').length, 1);
      expect(c.uploading, false);
      c.dispose();
      await g.stream.close();
    },
  );

  test(
    'disposed controller never starts uploads from delayed picker',
    () async {
      final g = FakeGateway();
      final c = LiveController(g, showing: 'engine')..sessionId = 's';
      final picker = Completer<List<Json>>();
      g.handler = (method, args) async =>
          method == 'pickAttachments' ? picker.future : g.normal(method, args);
      final work = c.attach();
      await flush();
      c.dispose();
      picker.complete([file('old.png')]);
      await work;
      expect(g.calls.where((v) => v.$1 == 'uploadAttachment'), isEmpty);
      await g.stream.close();
    },
  );
}
