import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('native Android clipboard bridge reads text without files', (
    t,
  ) async {
    const marker = 'native clipboard fixture';
    final original = await Clipboard.getData(Clipboard.kTextPlain);
    try {
      await Clipboard.setData(const ClipboardData(text: marker));
      final result = obj(await Gateway().call('readClipboard'));
      expect(result['text'], marker);
      expect(result['files'], isEmpty);
      expect(t.takeException(), isNull);
      debugPrint('OS_CLIPBOARD:plaintext-read-empty-files');
    } finally {
      await Clipboard.setData(ClipboardData(text: original?.text ?? ''));
    }
  });

  testWidgets(
    'real Android document picker returns and uploads two selected files',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      const id = String.fromEnvironment('PIRC_FILES_SESSION');
      const link = String.fromEnvironment('PIRC_PAIR_LINK');
      expect(
        id.isNotEmpty,
        isTrue,
        reason: 'Run the isolated helper with --files.',
      );
      expect(link.isNotEmpty, isTrue, reason: 'Missing private pairing link.');

      final g = Gateway();
      Map<String, dynamic>? originalPreferences;
      LiveController? controller;
      var paired = false;
      var appMounted = false;
      try {
        await g.call('pair', {'link': link});
        paired = true;
        await g.call('completeOnboarding');
        originalPreferences = obj(await g.call('preferences'));
        controller = LiveController(g);
        final c = controller;
        final theme = await PircTheme.load();

        Future<void> until(bool Function() ready, String step) async {
          for (var i = 0; i < 450 && !ready(); i++) {
            await t.pump(const Duration(milliseconds: 200));
          }
          expect(
            ready(),
            isTrue,
            reason:
                '$step: ${c.error ?? c.actionError ?? c.connection}; '
                'sessionVisible=${c.sessionVisible}, initializing=${c.initializing}',
          );
          expect(t.takeException(), isNull, reason: step);
        }

        Future<void> tap(Finder target) async {
          await t.ensureVisible(target);
          await t.pumpAndSettle();
          expect(target.hitTestable(), findsOneWidget);
          await t.tap(target);
          await t.pumpAndSettle();
        }

        await t.pumpWidget(MobileApp(theme: theme, controller: c));
        appMounted = true;
        await until(
          () => !c.booting && c.sessions.any((session) => session['id'] == id),
          'boot the files fixture',
        );
        await tap(find.text('Native files fixture'));
        await until(
          () =>
              c.sessionId == id &&
              c.state.isNotEmpty &&
              c.sessionVisible &&
              find.byTooltip('Attach files').evaluate().isNotEmpty,
          'open the fixture chat and show the composer',
        );

        final attach = find.byTooltip('Attach files');
        await t.ensureVisible(attach);
        await t.pumpAndSettle();
        expect(attach.hitTestable(), findsOneWidget);
        await t.tap(attach);
        await t.pump();
        await until(() => c.uploading, 'open Android DocumentsUI');
        debugPrint('OS_PICKER:select-both-files-in-DocumentsUI');

        await until(
          () => !c.uploading && c.attachments.length == 2,
          'read and upload both selected files',
        );
        expect(
          c.attachments.map((attachment) => attachment['name']).toList(),
          ['pirc-picker-note.txt', 'pirc-picker-image.png'],
          reason: 'Android picker selection order',
        );

        final note = c.attachments[0];
        final image = c.attachments[1];
        expect('${note['id']}', isNotEmpty);
        expect('${note['id']}', isNot(startsWith('local-')));
        expect(note['kind'], 'file');
        expect(note['mimeType'], 'text/plain');
        expect(note['size'], greaterThan(0));
        expect(note['uploading'], isNot(true));
        expect('${image['id']}', isNotEmpty);
        expect('${image['id']}', isNot(startsWith('local-')));
        expect(image['kind'], 'image');
        expect(image['mimeType'], 'image/png');
        expect(image['size'], greaterThan(0));
        expect(image['previewBytes'], isNotEmpty);
        expect(image['uploading'], isNot(true));

        final strip = find.byKey(const Key('composer-attachments-strip'));
        expect(find.text('pirc-picker-note.txt'), findsOneWidget);
        expect(find.text('pirc-picker-image.png'), findsOneWidget);
        expect(
          find.descendant(of: strip, matching: find.byType(Image)),
          findsOneWidget,
          reason: 'the selected PNG remains available for its local preview',
        );
        expect(find.byTooltip('Remove pirc-picker-note.txt'), findsOneWidget);
        debugPrint('OS_PICKER:two-files-uploaded-and-previewed');

        // Keep the two server IDs and the selected image bytes before the UI
        // clears its attachment chips after an accepted send. The gateway's
        // persisted user-message format has no uploadIds field: file uploads
        // are represented by their ID-bearing workspace path, while image
        // uploads are represented by their actual image bytes.
        final noteUploadId = '${note['id']}';
        final imageUploadId = '${image['id']}';
        final selectedImageBytes = List<int>.from(
          image['previewBytes'] as List<int>,
        );
        expect(noteUploadId, isNot(imageUploadId));
        final prompt =
            'Verify the selected picker attachments ${DateTime.now().microsecondsSinceEpoch}.';
        await t.ensureVisible(find.byKey(const Key('live-draft')));
        await t.enterText(find.byKey(const Key('live-draft')), prompt);
        await t.pumpAndSettle();
        await tap(find.byTooltip('Send message'));

        await until(
          () => c.messages.any((message) {
            if (message['role'] != 'user') return false;
            final content = message['content'];
            if (content is String) return content.contains(prompt);
            return rows(content)
                .where((part) => part['type'] == 'text')
                .any((part) => '${part['text']}'.contains(prompt));
          }),
          'persist the message sent with both selected attachments',
        );
        expect(
          c.attachments,
          isEmpty,
          reason: 'accepted send clears the chips',
        );

        // Read the session snapshot independently from the UI stream so this
        // proves the gateway stored the user message and its attachment data.
        final persistedSnapshot = await g.request(
          '/api/sessions/${enc(id)}/snapshot',
        );
        final matchingMessages = rows(persistedSnapshot['history']).where((
          message,
        ) {
          if (message['role'] != 'user') return false;
          final content = message['content'];
          if (content is String) return content.contains(prompt);
          return rows(content)
              .where((part) => part['type'] == 'text')
              .any((part) => '${part['text']}'.contains(prompt));
        }).toList();
        expect(matchingMessages, hasLength(1));
        final persistedContent = rows(matchingMessages.single['content']);
        final persistedText = persistedContent
            .where((part) => part['type'] == 'text')
            .map((part) => '${part['text']}')
            .join();
        expect(persistedText, contains(prompt));
        expect(
          persistedText,
          contains('$noteUploadId-pirc-picker-note.txt'),
          reason: 'the persisted file reference carries its server upload ID',
        );
        final persistedImages = persistedContent
            .where((part) => part['type'] == 'image')
            .toList();
        expect(persistedImages, hasLength(1));
        expect(persistedImages.single['mimeType'], 'image/png');
        expect(
          base64Decode('${persistedImages.single['data']}'),
          orderedEquals(selectedImageBytes),
          reason:
              'the backend resolved the selected image upload ($imageUploadId) into this message',
        );
        debugPrint(
          'OS_PICKER:backend-message-persisted-note=$noteUploadId,image=$imageUploadId',
        );
      } finally {
        await t.pumpWidget(const SizedBox());
        try {
          await g.call('unwatch');
        } finally {
          try {
            if (originalPreferences != null) {
              await g.call('savePreferences', originalPreferences);
            }
          } finally {
            if (!appMounted) controller?.dispose();
            if (paired) await g.call('unpair');
          }
        }
      }
    },
    timeout: const Timeout(Duration(minutes: 8)),
  );
}
