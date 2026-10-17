import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/conversation_composer.dart';
import 'live_test.dart' show FakeGateway, theme;
import 'attachment_upload_test.dart' show file;

void main() {
  for (final reading in [true, false]) {
    test(
      'new chat can send while old ${reading ? 'picker' : 'upload'} is pending',
      () async {
        final g = FakeGateway(), c = LiveController(g)..sessionId = 'old';
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
    final g = FakeGateway(), c = LiveController(g)..sessionId = 'old';
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

  for (final width in [390.0, 768.0]) {
    for (final brightness in Brightness.values) {
      testWidgets(
        'Stop remains actionable during pending steer at $width in ${brightness.name}',
        (t) async {
          t.view.devicePixelRatio = 1;
          t.view.physicalSize = Size(width, 900);
          addTearDown(t.view.reset);
          final g = FakeGateway(),
              c = LiveController(g)
                ..sessionId = 's'
                ..connection = 'live'
                ..control = {'held': true}
                ..state = {
                  'run': {'status': 'running'},
                }
                ..draft = 'steer';
          final steer = Completer<Json>();
          g.handler = (method, args) async {
            if (method == 'command' &&
                (args['payload'] as Json)['type'] == 'steer') {
              return steer.future;
            }
            return g.normal(method, args);
          };
          final sending = c.send('steer');
          final text = TextEditingController(text: c.draft);
          await t.pumpWidget(
            MaterialApp(
              theme: theme.build(brightness),
              home: Scaffold(
                body: AnimatedBuilder(
                  animation: c,
                  builder: (_, _) =>
                      ConversationComposer(controller: c, text: text),
                ),
              ),
            ),
          );
          await t.pump();
          await t.tap(find.byTooltip('Stop run'));
          await t.pump();
          final stopped = g.calls
              .where(
                (call) =>
                    call.$1 == 'command' &&
                    (call.$2['payload'] as Json)['type'] == 'stop',
              )
              .length;
          final stillBusy = c.busy;
          steer.complete({'status': 'accepted'});
          await sending;
          final done = !c.busy;
          await t.pumpWidget(const SizedBox());
          text.dispose();
          c.dispose();
          await g.stream.close();
          expect(stopped, 1);
          expect(stillBusy, isTrue);
          expect(done, isTrue);
        },
      );
    }
  }
  test('Stop still requires a live connection and held control', () async {
    final g = FakeGateway(),
        c = LiveController(g)
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
