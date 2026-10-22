import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'live_test.dart' show FakeGateway;
import 'attachment_upload_test.dart' show file;

void main() {
  for (final reading in [true, false]) {
    test(
      'new chat can send while old ${reading ? 'picker' : 'upload'} is pending',
      () async {
        final g = FakeGateway(),
            c = LiveController(g, showing: 'engine')..sessionId = 'old';
        final pending = Completer<dynamic>();
        g.handler = (method, args) async {
          if (method == 'pickAttachments') {
            return reading ? pending.future : [file('old.png')];
          }
          if (method == 'uploadAttachment') return pending.future;
          return g.normal(method, args);
        };
        final old = c.attach();
        await Future<void>.delayed(Duration.zero);
        await c.open('new');
        c.connection = 'live';
        c.control = {'held': true};
        final blocked = c.uploading;
        c.editDraft('new chat message');
        await c.send('prompt');
        pending.complete(reading ? [file('old.png')] : {'id': 'old-upload'});
        await old;
        final messages = g.calls
            .where(
              (call) =>
                  call.$1 == 'command' &&
                  (call.$2['payload'] as Json)['type'] == 'prompt',
            )
            .toList();
        final attachments = List<Json>.of(c.attachments);
        c.dispose();
        await g.stream.close();
        expect(blocked, isFalse);
        expect(messages, hasLength(1));
        expect(messages.single.$2['sessionId'], 'new');
        expect((messages.single.$2['payload'] as Json)['uploadIds'], isEmpty);
        expect(attachments, isEmpty);
      },
    );
  }

  test('old upload completion cannot unblock a newer pending upload', () async {
    final g = FakeGateway(),
        c = LiveController(g, showing: 'engine')..sessionId = 'old';
    final old = Completer<Json>(), fresh = Completer<Json>();
    g.handler = (method, args) async {
      if (method == 'pickAttachments') return [file('${c.sessionId}.png')];
      if (method == 'uploadAttachment') {
        return args['sessionId'] == 'old' ? old.future : fresh.future;
      }
      return g.normal(method, args);
    };
    final first = c.attach();
    await Future<void>.delayed(Duration.zero);
    await c.open('new');
    final second = c.attach();
    await Future<void>.delayed(Duration.zero);
    final uploadCount = g.calls
        .where((call) => call.$1 == 'uploadAttachment')
        .length;
    old.complete({'id': 'obsolete'});
    await first;
    final stillPending = c.uploading;
    final pendingNames = c.attachments.map((a) => a['name']).toList();
    fresh.complete({'id': 'fresh', 'name': 'new.png'});
    await second;
    final ids = c.attachments.map((a) => a['id']).toList();
    final completed = !c.uploading;
    c.dispose();
    await g.stream.close();
    expect(uploadCount, 2);
    expect(stillPending, isTrue);
    expect(pendingNames, ['new.png']);
    expect(ids, ['fresh']);
    expect(completed, isTrue);
  });

  test('Stop still requires a live connection and held control', () async {
    final g = FakeGateway(),
        c = LiveController(g, showing: 'engine')
          ..sessionId = 's'
          ..busy = true;
    c.connection = 'offline';
    c.control = {'held': true};
    expect(await c.sendCommand({'type': 'stop'}), isFalse);
    c.connection = 'live';
    c.control = {'held': false};
    expect(await c.sendCommand({'type': 'stop'}), isFalse);
    expect(g.calls.where((call) => call.$1 == 'command'), isEmpty);
    c.dispose();
    await g.stream.close();
  });
}
