import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/work_index.dart';
import 'package:pirc_mobile/live/workspace_project_files.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'real Android project files upload, replace, list, and delete safely',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      const link = String.fromEnvironment('PIRC_PAIR_LINK');
      expect(link, isNotEmpty, reason: 'Missing private pairing link.');

      final gateway = Gateway();
      LiveController? controller;
      String? workspaceId;
      var paired = false;
      String? pickedFixtureName;

      Future<void> until(bool Function() ready, String step) async {
        for (var i = 0; i < 300 && !ready(); i++) {
          await t.pump(const Duration(milliseconds: 100));
        }
        expect(ready(), isTrue, reason: step);
        expect(t.takeException(), isNull, reason: step);
      }

      Future<Json> listing(String id) =>
          gateway.request('/api/workspaces/${enc(id)}/files');

      Future<Json> uploadProjectFile({
        required String workspace,
        required String name,
        required Uint8List bytes,
        required String pairingStamp,
        required int maxBytes,
      }) async => obj(
        await gateway.call('uploadProjectFile', {
          'workspaceId': workspace,
          'name': name,
          'bytes': bytes,
          'pairingStamp': pairingStamp,
          'maxBytes': maxBytes,
        }),
      );

      try {
        await gateway.call('pair', {'link': link});
        paired = true;
        await gateway.call('completeOnboarding');
        final boot = obj(await gateway.call('boot'));
        final pairingStamp = boot['pairingStamp'] as String;
        final workspaces = rows(
          (await gateway.request('/api/workspaces'))['workspaces'],
        );
        final created = await gateway.request(
          '/api/workspaces',
          method: 'POST',
          body: {
            'kind': 'chat',
            'nodeId': '${workspaces.firstWhere(isChat)['hostId']}',
            'displayName':
                'Native project files ${DateTime.now().microsecondsSinceEpoch}',
          },
        );
        final workspace = obj(created['workspace']);
        workspaceId = '${workspace['id']}';
        expect(workspaceId, isNotEmpty);
        expect(isChat(workspace), isTrue);

        final empty = await listing(workspaceId);
        expect(rows(empty['files']), isEmpty);
        final maxFiles = (empty['maxFiles'] as num).toInt();
        final maxBytes = (empty['maxBytes'] as num).toInt();
        expect(maxFiles, greaterThan(0));
        expect(maxBytes, greaterThan(9 * 1024 * 1024));

        // Keep the established per-session attachment upload path working in
        // the same isolated project that owns project files.
        final createdSession = await gateway.request(
          '/api/sessions',
          method: 'POST',
          body: {'workspaceId': workspaceId},
        );
        final sessionId = '${obj(createdSession['session'])['id']}';
        final attachmentBytes = Uint8List.fromList(
          utf8.encode('existing session attachment remains supported'),
        );
        final attachment = obj(
          await gateway.call('uploadAttachment', {
            'sessionId': sessionId,
            'name': 'session-note.txt',
            'mimeType': 'text/plain',
            'bytes': attachmentBytes,
          }),
        );
        expect('${attachment['id']}', isNotEmpty);
        expect(attachment['kind'], 'file');
        expect(attachment['size'], attachmentBytes.length);

        const fileName = '設定 notes.json';
        const jsonSource =
            '{"message":"你好，project files 🌱","spaces":"stay intact"}';
        final jsonBytes = Uint8List.fromList(utf8.encode(jsonSource));
        await uploadProjectFile(
          workspace: workspaceId,
          name: fileName,
          bytes: jsonBytes,
          pairingStamp: pairingStamp,
          maxBytes: maxBytes,
        );
        final firstList = await listing(workspaceId);
        final firstFiles = rows(firstList['files']);
        final firstJson = firstFiles.singleWhere(
          (file) => file['name'] == fileName,
        );
        expect(firstJson['byteSize'], jsonBytes.length);
        expect(firstList['maxFiles'], maxFiles);
        expect(firstList['maxBytes'], maxBytes);

        const replacementSource = '{"message":"replacement ✓","count":2}';
        final replacementBytes = Uint8List.fromList(
          utf8.encode(replacementSource),
        );
        await uploadProjectFile(
          workspace: workspaceId,
          name: fileName,
          bytes: replacementBytes,
          pairingStamp: pairingStamp,
          maxBytes: maxBytes,
        );
        final replacementList = await listing(workspaceId);
        final replacementFiles = rows(replacementList['files']);
        expect(
          replacementFiles.where((file) => file['name'] == fileName),
          hasLength(1),
        );
        expect(
          replacementFiles.singleWhere(
            (file) => file['name'] == fileName,
          )['byteSize'],
          replacementBytes.length,
        );

        // This crosses the legacy attachment cap while staying below the
        // server's advertised per-file project limit.
        const largeSize = 9 * 1024 * 1024;
        final largeText = Uint8List(largeSize)..fillRange(0, largeSize, 0x61);
        await uploadProjectFile(
          workspace: workspaceId,
          name: 'nine-megabytes.txt',
          bytes: largeText,
          pairingStamp: pairingStamp,
          maxBytes: maxBytes,
        );
        final afterLargeUpload = await listing(workspaceId);
        final largeFile = rows(
          afterLargeUpload['files'],
        ).singleWhere((file) => file['name'] == 'nine-megabytes.txt');
        expect(largeFile['byteSize'], largeSize);
        expect(afterLargeUpload['maxBytes'], greaterThan(largeSize));

        const exerciseNativePicker = bool.fromEnvironment(
          'PIRC_PROJECT_FILES_PICKER',
        );
        if (exerciseNativePicker) {
          const pickerName = 'pirc-project-file-picker.txt';
          const pickerContent = 'Native project picker fixture\n';
          debugPrint('PROJECT_FILES:awaiting-native-picker');
          final selectedFiles = rows(
            await gateway
                .call('pickProjectFiles', {
                  'workspaceId': workspaceId,
                  'pairingStamp': pairingStamp,
                  'maxBytes': maxBytes,
                  'multiple': false,
                })
                .timeout(const Duration(minutes: 2)),
          );
          final tokens = selectedFiles
              .map((file) => file['fileToken'])
              .whereType<String>()
              .where((token) => token.isNotEmpty)
              .toList(growable: false);
          try {
            expect(selectedFiles, hasLength(1));
            final selected = selectedFiles.single;
            expect(selected['name'], pickerName);
            expect(selected['fileToken'], isA<String>());
            final token = selected['fileToken'] as String;
            expect(token, isNotEmpty);
            pickedFixtureName = pickerName;
            await gateway.call('uploadProjectFile', {
              'workspaceId': workspaceId,
              'name': pickerName,
              'fileToken': token,
              'pairingStamp': pairingStamp,
              'maxBytes': maxBytes,
            });
          } finally {
            if (tokens.isNotEmpty) {
              await gateway.call('releaseProjectFiles', {'fileTokens': tokens});
            }
          }
          final pickerFile = rows(
            (await listing(workspaceId))['files'],
          ).singleWhere((file) => file['name'] == pickerName);
          expect(pickerFile['byteSize'], utf8.encode(pickerContent).length);
        }

        await expectLater(
          uploadProjectFile(
            workspace: workspaceId,
            name: '.hidden.json',
            bytes: Uint8List.fromList([0x7b, 0x7d]),
            pairingStamp: pairingStamp,
            maxBytes: maxBytes,
          ),
          throwsA(isA<PlatformException>()),
          reason: 'Hidden and dot-prefixed project file names are rejected.',
        );
        expect(
          rows(
            (await listing(workspaceId))['files'],
          ).any((file) => file['name'] == '.hidden.json'),
          isFalse,
        );

        final nodes = rows((await gateway.request('/api/nodes'))['nodes']);
        controller = LiveController(gateway)
          ..origin = boot['origin'] as String?
          ..clientId = boot['clientId'] as String?
          ..pairingStamp = pairingStamp
          ..workspaces = [...workspaces, workspace]
          ..nodes = nodes;
        final theme = await PircTheme.load();
        await t.pumpWidget(
          MaterialApp(
            theme: theme.build(Brightness.light),
            home: Scaffold(
              body: SingleChildScrollView(
                child: WorkspaceProjectFiles(
                  controller: controller,
                  workspace: workspace,
                ),
              ),
            ),
          ),
        );

        final removeKey = Key('project-file-remove-$fileName');
        final confirmKey = Key('project-file-confirm-remove-$fileName');
        final cancelKey = Key('project-file-cancel-remove-$fileName');
        await until(
          () => find.byKey(removeKey).evaluate().isNotEmpty,
          'project file list loads through the real native bridge',
        );
        await t.ensureVisible(find.byKey(removeKey));
        await t.tap(find.byKey(removeKey));
        await t.pump();
        expect(find.byKey(confirmKey), findsOneWidget);
        expect(find.byKey(cancelKey), findsOneWidget);
        await t.ensureVisible(find.byKey(cancelKey));
        await t.tap(find.byKey(cancelKey));
        await until(
          () => find.byKey(removeKey).evaluate().isNotEmpty,
          'cancel leaves the file available for removal',
        );
        expect(
          rows(
            (await listing(workspaceId))['files'],
          ).any((file) => file['name'] == fileName),
          isTrue,
        );

        await t.ensureVisible(find.byKey(removeKey));
        await t.tap(find.byKey(removeKey));
        await t.pump();
        await t.ensureVisible(find.byKey(confirmKey));
        await t.tap(find.byKey(confirmKey));
        var removed = false;
        for (var i = 0; i < 100 && !removed; i++) {
          removed = !rows(
            (await listing(workspaceId))['files'],
          ).any((file) => file['name'] == fileName);
          if (!removed) await t.pump(const Duration(milliseconds: 100));
        }
        expect(
          removed,
          isTrue,
          reason: 'The real gateway has removed the file before UI refresh.',
        );
        await until(
          () => find.byKey(removeKey).evaluate().isEmpty,
          'confirmed project file removal refreshes the native list',
        );
        final remainingFiles = rows((await listing(workspaceId))['files']);
        expect(
          remainingFiles.any((file) => file['name'] == 'nine-megabytes.txt'),
          isTrue,
          reason: 'Removing one file preserves the other project files.',
        );
        if (pickedFixtureName != null) {
          expect(
            remainingFiles.any((file) => file['name'] == pickedFixtureName),
            isTrue,
            reason: 'Removing another file preserves the picker upload.',
          );
        }
        expect(t.takeException(), isNull);
        debugPrint(
          'PROJECT_FILES:native upload/replacement/9MiB/list/delete-confirmation and session attachments passed',
        );
      } finally {
        await t.pumpWidget(const SizedBox.shrink());
        controller?.dispose();
        try {
          if (workspaceId != null) {
            await gateway.request(
              '/api/workspaces/${enc(workspaceId)}/deletion',
              method: 'POST',
              body: const {'decisions': []},
            );
          }
        } finally {
          if (paired) await gateway.call('unpair');
        }
      }
    },
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
