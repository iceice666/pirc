import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/theme.dart';

class FixtureAttachmentGateway extends Gateway {
  static final png = Uint8List.fromList(
    base64Decode(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    ),
  );

  int pickerCalls = 0;

  @override
  Future<dynamic> call(String method, [Json args = const {}]) async {
    if (method == 'pickAttachments') {
      pickerCalls++;
      return [
        {
          'name': 'fixture.png',
          'mimeType': 'image/png',
          'bytes': Uint8List.fromList(png),
        },
        {
          'name': 'note.txt',
          'mimeType': 'text/plain',
          'bytes': Uint8List.fromList(utf8.encode('attachment fixture\n')),
        },
      ];
    }
    return super.call(method, args);
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'real Android attachment upload and composer preview',
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

      final g = FixtureAttachmentGateway();
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
          for (var i = 0; i < 180 && !ready(); i++) {
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
        await until(
          () => !c.uploading && c.attachments.length == 2,
          'read and upload both fixture files',
        );

        expect(g.pickerCalls, 1);
        expect(
          c.attachments.map((attachment) => attachment['name']).toList(),
          ['fixture.png', 'note.txt'],
          reason: 'keep the picker order',
        );
        final image = c.attachments[0];
        final file = c.attachments[1];
        expect('${image['id']}', isNotEmpty);
        expect('${image['id']}', isNot(startsWith('local-')));
        expect(image['kind'], 'image');
        expect(image['mimeType'], 'image/png');
        expect(image['size'], FixtureAttachmentGateway.png.length);
        expect(image['uploading'], isNot(true));
        expect('${file['id']}', isNotEmpty);
        expect('${file['id']}', isNot(startsWith('local-')));
        expect(file['kind'], 'file');
        expect(file['mimeType'], 'text/plain');
        expect(file['size'], utf8.encode('attachment fixture\n').length);
        expect(file['uploading'], isNot(true));

        final strip = find.byKey(const Key('composer-attachments-strip'));
        expect(find.text('fixture.png'), findsOneWidget);
        expect(find.text('note.txt'), findsOneWidget);
        expect(
          find.descendant(of: strip, matching: find.byType(Image)),
          findsOneWidget,
          reason: 'the image chip keeps its local PNG preview',
        );
        expect(find.byTooltip('Remove note.txt'), findsOneWidget);
        await tap(find.byTooltip('Remove note.txt'));
        expect(c.attachments, hasLength(1));
        expect(c.attachments.single['name'], 'fixture.png');
        expect(find.text('note.txt'), findsNothing);

        await expectLater(
          g.call('uploadAttachment', {
            'sessionId': id,
            'name': 'too-large.txt',
            'mimeType': 'text/plain',
            'bytes': Uint8List(8 * 1024 * 1024 + 1),
          }),
          throwsA(
            isA<PlatformException>().having((e) => e.code, 'code', 'INVALID'),
          ),
        );
        await expectLater(
          g.call('uploadAttachment', {
            'sessionId': id,
            'name': 'mismatched.png',
            'mimeType': 'text/plain',
            'bytes': Uint8List.fromList(FixtureAttachmentGateway.png),
          }),
          throwsA(
            isA<PlatformException>().having((e) => e.code, 'code', 'HTTP_400'),
          ),
        );
        expect(c.attachments, hasLength(1));
        expect(t.takeException(), isNull);
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
            // LiveShell owns the controller once mounted and disposes it on unmount.
            if (!appMounted) controller?.dispose();
            if (paired) await g.call('unpair');
          }
        }
      }
    },
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
