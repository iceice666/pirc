import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/composer_clipboard.dart';
import 'package:pirc_mobile/live/conversation_composer.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'live_test.dart' show FakeGateway, theme;

Json image() => {
  'name': 'paste.png',
  'mimeType': 'image/png',
  'bytes': Uint8List.fromList([1, 2, 3]),
};

void main() {
  test('mixed clipboard replaces selected text and uploads images', () async {
    final g = FakeGateway();
    final c = LiveController(g)..sessionId = 's';
    final text = TextEditingController(text: 'before OLD after')
      ..selection = const TextSelection(baseOffset: 7, extentOffset: 10);
    g.handler = (method, args) async {
      if (method == 'readClipboard') {
        return {
          'text': 'NEW',
          'files': [image()],
        };
      }
      if (method == 'uploadAttachment') {
        return {'id': 'server', 'kind': 'image'};
      }
      return g.normal(method, args);
    };
    await pasteComposerClipboard(c, text);
    expect(text.text, 'before NEW after');
    expect(text.selection, const TextSelection.collapsed(offset: 10));
    expect(c.draft, text.text);
    expect(c.attachments.single['id'], 'server');
    expect(c.attachments.single['previewBytes'], image()['bytes']);
    text.dispose();
    c.dispose();
    await g.stream.close();
  });

  test(
    'delayed clipboard cannot replace a newer edit or another chat',
    () async {
      final g = FakeGateway();
      final c = LiveController(g)..sessionId = 's';
      final text = TextEditingController(text: 'old');
      final clip = Completer<Json>();
      g.handler = (method, args) async =>
          method == 'readClipboard' ? clip.future : g.normal(method, args);
      final pasting = pasteComposerClipboard(c, text);
      text.text = 'new edit';
      await c.open('other');
      clip.complete({
        'text': 'clipboard',
        'files': [image()],
      });
      await pasting;
      expect(text.text, 'new edit');
      expect(c.attachments, isEmpty);
      expect(g.calls.where((call) => call.$1 == 'uploadAttachment'), isEmpty);
      text.dispose();
      c.dispose();
      await g.stream.close();
    },
  );

  test('delayed read preserves a newer edit in the same chat', () async {
    final g = FakeGateway();
    final c = LiveController(g)..sessionId = 's';
    final text = TextEditingController(text: 'old');
    final clip = Completer<Json>();
    g.handler = (method, args) async {
      if (method == 'readClipboard') return clip.future;
      if (method == 'uploadAttachment') {
        return {'id': 'server', 'kind': 'image'};
      }
      return g.normal(method, args);
    };
    final pasting = pasteComposerClipboard(c, text);
    text.text = 'new edit';
    clip.complete({
      'text': 'clipboard',
      'files': [image()],
    });
    await pasting;
    expect(text.text, 'new edit');
    expect(c.attachments.single['id'], 'server');
    text.dispose();
    c.dispose();
    await g.stream.close();
  });

  test('per-image read failure retains mixed clipboard text', () async {
    final g = FakeGateway();
    final c = LiveController(g)..sessionId = 's';
    final text = TextEditingController();
    g.handler = (method, args) async => method == 'readClipboard'
        ? {
            'text': 'retained',
            'files': [
              {'name': 'unreadable.png', 'error': 'Permission denied'},
            ],
          }
        : g.normal(method, args);
    await pasteComposerClipboard(c, text);
    expect(text.text, 'retained');
    expect(c.actionError, contains('Permission denied'));
    expect(c.attachments, isEmpty);
    text.dispose();
    c.dispose();
    await g.stream.close();
  });

  testWidgets('image-only clipboard shows Paste and uses composer upload', (
    t,
  ) async {
    final g = FakeGateway();
    final c = LiveController(g)
      ..sessionId = 's'
      ..connection = 'live';
    final text = TextEditingController(text: 'draft');
    g.handler = (method, args) async {
      if (method == 'clipboardImagesAvailable') return true;
      if (method == 'readClipboard') {
        return {
          'text': '',
          'files': [image()],
        };
      }
      if (method == 'uploadAttachment') {
        return {'id': 'server', 'kind': 'image'};
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
    text.selection = const TextSelection.collapsed(offset: 2);
    final state = t.state<EditableTextState>(find.byType(EditableText));
    state.showToolbar();
    await t.pumpAndSettle();
    expect(find.text('Paste'), findsOneWidget);
    await t.tap(find.text('Paste'));
    await t.pumpAndSettle();
    expect(text.text, 'draft');
    expect(text.selection, const TextSelection.collapsed(offset: 2));
    expect(c.attachments.single['id'], 'server');
    expect(g.calls.where((call) => call.$1 == 'pickAttachments'), isEmpty);
    await t.pumpWidget(const SizedBox());
    text.dispose();
    c.dispose();
    await g.stream.close();
  });

  testWidgets('keyboard Paste action uses native mixed clipboard', (t) async {
    final g = FakeGateway();
    final c = LiveController(g)
      ..sessionId = 's'
      ..connection = 'live';
    final text = TextEditingController(text: 'draft');
    g.handler = (method, args) async {
      if (method == 'readClipboard') return {'text': '!', 'files': []};
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
    text.selection = const TextSelection.collapsed(offset: 2);
    await t.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await t.sendKeyEvent(LogicalKeyboardKey.keyV);
    await t.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await t.pumpAndSettle();
    expect(text.text, 'dr!aft');
    expect(c.draft, 'dr!aft');
    expect(g.calls.where((call) => call.$1 == 'readClipboard'), hasLength(1));
    await t.pumpWidget(const SizedBox());
    text.dispose();
    c.dispose();
    await g.stream.close();
  });
}
