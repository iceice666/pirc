import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/conversation_composer.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'live_test.dart' show FakeGateway, theme;

void main() {
  testWidgets('keyboard image commits preserve text and upload every image', (
    t,
  ) async {
    final g = FakeGateway();
    final c = LiveController(g)
      ..sessionId = 's'
      ..connection = 'live';
    final text = TextEditingController(text: 'keep mixed text');
    final pending = <Completer<Json>>[];
    g.handler = (method, args) async {
      if (method == 'uploadAttachment') {
        final next = Completer<Json>();
        pending.add(next);
        return next.future;
      }
      return g.normal(method, args);
    };
    await t.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        home: Scaffold(
          body: Column(
            children: [
              const Spacer(),
              ConversationComposer(controller: c, text: text),
            ],
          ),
        ),
      ),
    );
    await t.showKeyboard(find.byKey(const Key('live-draft')));
    text.selection = const TextSelection.collapsed(offset: 4);
    final selection = text.selection;
    for (final name in ['first.png', 'second.png']) {
      await t.binding.defaultBinaryMessenger.handlePlatformMessage(
        'flutter/textinput',
        const JSONMessageCodec().encodeMessage({
          'method': 'TextInputClient.performAction',
          'args': [
            -1,
            'TextInputAction.commitContent',
            {
              'mimeType': 'image/png',
              'uri': 'content://keyboard/$name',
              'data': [1, 2, 3],
            },
          ],
        }),
        (_) {},
      );
      await t.pump();
    }
    expect(pending, hasLength(2));
    expect(g.calls.where((call) => call.$1 == 'pickAttachments'), isEmpty);
    expect(c.attachments.map((item) => item['name']), [
      'first.png',
      'second.png',
    ]);
    expect(text.text, 'keep mixed text');
    expect(text.selection, selection);
    pending[1].complete({'id': 'second', 'kind': 'image'});
    await t.pump();
    expect(c.uploading, isTrue);
    pending[0].complete({'id': 'first', 'kind': 'image'});
    await t.pump();
    expect(c.uploading, isFalse);
    expect(c.attachments.map((item) => item['id']), ['first', 'second']);
    expect(c.attachments.first['previewBytes'], Uint8List.fromList([1, 2, 3]));
    await t.pumpWidget(const SizedBox());
    text.dispose();
    c.dispose();
    await g.stream.close();
  });

  test(
    'missing image bytes reports error, non-image content is ignored',
    () async {
      final g = FakeGateway();
      final c = LiveController(g)..sessionId = 's';
      await c.insertImage(
        const KeyboardInsertedContent(
          mimeType: 'image/png',
          uri: 'content://keyboard/photo.png',
        ),
      );
      expect(c.actionError, contains('keyboard did not provide image data'));
      expect(c.attachments, isEmpty);
      expect(c.uploading, isFalse);
      await c.insertImage(
        KeyboardInsertedContent(
          mimeType: 'text/plain',
          uri: 'content://keyboard/text',
          data: Uint8List.fromList([1]),
        ),
      );
      expect(g.calls, isEmpty);
      c.dispose();
      await g.stream.close();
    },
  );
}
