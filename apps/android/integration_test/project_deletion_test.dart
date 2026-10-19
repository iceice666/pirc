// Opt-in real Android/Rust integration for project deletion. The local
// real_gateway.ts fixture supplies a scripted memory_note call; project and
// chat records, preview, deletion, files and source attribution use Rust APIs.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/project_deletion_dialog.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'real Android project deletion previews, reviews memory, and cleans the project',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      const link = String.fromEnvironment('PIRC_PAIR_LINK');
      expect(link, isNotEmpty, reason: 'Missing private pairing link.');

      final gateway = Gateway();
      LiveController? controller;
      String? projectId;
      String? topLevelSessionId;
      String? mixedWriterSessionId;
      String? pairingStamp;
      var paired = false;
      var projectDeleted = false;

      Future<void> until(bool Function() ready, String step) async {
        for (var i = 0; i < 300 && !ready(); i++) {
          await t.pump(const Duration(milliseconds: 100));
        }
        expect(ready(), isTrue, reason: step);
        expect(t.takeException(), isNull, reason: step);
      }

      Future<Json> waitForNote(String content) async {
        for (var i = 0; i < 200; i++) {
          final memory = await gateway.request('/api/memory');
          final matches = rows(
            memory['notes'],
          ).where((entry) => entry['content'] == content).toList();
          if (matches.isNotEmpty) {
            expect(matches, hasLength(1));
            return matches.single;
          }
          await t.pump(const Duration(milliseconds: 100));
        }
        debugPrint(
          'PROJECT_DELETION:run=${controller?.state["run"]}; messages=${controller?.messages.map((m) => {"role": m["role"], "content": m["content"]}).toList()}',
        );
        fail('Timed out waiting for memory note: $content');
      }

      Future<void> writeNoteFromChat({
        required String sessionId,
        required String command,
        required String expectedContent,
      }) async {
        final c = controller!;
        await c.open(sessionId, reveal: false);
        await until(
          () => c.canWrite && !c.running,
          'open chat $sessionId for memory fixture',
        );
        c.editDraft(command);
        await c.send('prompt');
        expect(c.actionError, isNull, reason: 'Send scripted memory_note.');
        await waitForNote(expectedContent);
        await until(
          () => c.canWrite && !c.running,
          'finish memory fixture command in $sessionId',
        );
      }

      Future<String> createSession(String workspaceId, String name) async {
        final created = await gateway.request(
          '/api/sessions',
          method: 'POST',
          body: {'workspaceId': workspaceId},
        );
        final id = '${obj(created['session'])['id']}';
        expect(id, isNotEmpty);
        await gateway.request(
          sessionPath(id),
          method: 'PATCH',
          body: {'name': name},
        );
        return id;
      }

      Future<void> finishProjectDeletionIfNeeded() async {
        final id = projectId;
        final stamp = pairingStamp;
        if (id == null || stamp == null || projectDeleted) return;
        final path = '/api/workspaces/${enc(id)}/deletion';
        try {
          final preview = await gateway.request(path, pairingStamp: stamp);
          final decisions = [
            for (final item in rows(preview['memory']))
              if (item['action'] == 'review')
                {
                  'entryId': obj(item['entry'])['id'],
                  'revision': obj(item['entry'])['revision'],
                  'action': 'keep',
                },
          ];
          await gateway.request(
            path,
            method: 'POST',
            pairingStamp: stamp,
            body: {'decisions': decisions},
          );
        } catch (_) {
          // The isolated helper is disposable. A failure here must not mask
          // the assertion that exposed it.
        }
      }

      try {
        await gateway.call('pair', {'link': link});
        paired = true;
        await gateway.call('completeOnboarding');
        final c = LiveController(gateway);
        controller = c;
        await c.boot();
        await until(
          () => !c.booting && c.workspaces.isNotEmpty,
          'boot the paired Android controller',
        );
        expect(c.error, isNull);
        expect(c.pairingStamp, isNotEmpty);
        final stamp = c.pairingStamp!;
        pairingStamp = stamp;

        final workspaces = List<Json>.of(c.workspaces);
        final chats = workspaces.firstWhere(c.catalog.topChats);
        final chatHost =
            workspaces.firstWhere(c.catalog.assistant)['hostId'] as String;
        final created = await gateway.request(
          '/api/workspaces',
          method: 'POST',
          body: {
            'kind': 'chat',
            'nodeId': chatHost,
            'displayName':
                'Native project deletion ${DateTime.now().microsecondsSinceEpoch}',
          },
        );
        final project = obj(created['workspace']);
        final currentProjectId = '${project['id']}';
        projectId = currentProjectId;
        expect(currentProjectId, isNotEmpty);
        expect(c.catalog.assistant(project), isTrue);
        expect(c.catalog.topChats(project), isFalse);

        await gateway.request(
          '/api/workspaces/${enc(currentProjectId)}/instructions',
          method: 'PATCH',
          body: {'text': 'Native project deletion fixture instructions.'},
        );
        final fileIndex = await gateway.request(
          '/api/workspaces/${enc(currentProjectId)}/files',
        );
        final maxBytes = (fileIndex['maxBytes'] as num).toInt();
        const fileName = 'project-deletion-fixture.txt';
        final fileBytes = Uint8List.fromList(
          utf8.encode('project file removed with its owning project'),
        );
        await gateway.call('uploadProjectFile', {
          'workspaceId': currentProjectId,
          'name': fileName,
          'bytes': fileBytes,
          'pairingStamp': stamp,
          'maxBytes': maxBytes,
        });
        expect(
          rows(
            (await gateway.request(
              '/api/workspaces/${enc(currentProjectId)}/files',
            ))['files'],
          ).any((file) => file['name'] == fileName),
          isTrue,
        );

        final chatsId = '${chats['id']}';
        final topChatId = await createSession(
          chatsId,
          'Top-level deletion fixture chat',
        );
        topLevelSessionId = topChatId;
        final projectChatId = await createSession(
          currentProjectId,
          'Project deletion fixture chat',
        );
        await c.refreshList();
        await c.attention.refreshMemory();

        final marker = DateTime.now().microsecondsSinceEpoch;
        final rollbackBefore = 'Deletion rollback original $marker';
        final rollbackProject = 'Deletion rollback project edit $marker';
        final mixedProject = 'Deletion mixed project note $marker';
        final mixedTopLevel = 'Deletion mixed top-level edit $marker';
        final mixedAfterConflict = 'Deletion mixed concurrent edit $marker';

        await writeNoteFromChat(
          sessionId: topChatId,
          command: '/parity-project-memory-add $rollbackBefore',
          expectedContent: rollbackBefore,
        );
        final rollbackEntry = await waitForNote(rollbackBefore);
        final rollbackId = '${rollbackEntry['id']}';
        await writeNoteFromChat(
          sessionId: projectChatId,
          command:
              '/parity-project-memory-replace $rollbackId $rollbackProject',
          expectedContent: rollbackProject,
        );
        final onlyProject = 'Deletion project-only note $marker';
        await writeNoteFromChat(
          sessionId: projectChatId,
          command: '/parity-project-memory-add $onlyProject',
          expectedContent: onlyProject,
        );
        await writeNoteFromChat(
          sessionId: projectChatId,
          command: '/parity-project-memory-add $mixedProject',
          expectedContent: mixedProject,
        );
        final mixedEntry = await waitForNote(mixedProject);
        final mixedId = '${mixedEntry['id']}';
        // A chat freezes the note revisions it saw when it started. A fresh
        // external chat must see this project note before replacing it.
        final mixedWriterId = await createSession(
          chatsId,
          'External mixed-memory writer',
        );
        mixedWriterSessionId = mixedWriterId;
        await c.refreshList();
        await writeNoteFromChat(
          sessionId: mixedWriterId,
          command: '/parity-project-memory-replace $mixedId $mixedTopLevel',
          expectedContent: mixedTopLevel,
        );

        final deletionPath =
            '/api/workspaces/${enc(currentProjectId)}/deletion';
        final preview = await gateway.request(
          deletionPath,
          pairingStamp: stamp,
        );
        expect(obj(preview['project'])['id'], currentProjectId);
        expect(preview['nodeOnline'], isTrue);
        expect(preview['deleting'], isFalse);
        expect(rows(preview['chats']), hasLength(1));
        final memoryPreview = rows(preview['memory']);
        final rollback = memoryPreview.singleWhere(
          (item) => obj(item['entry'])['id'] == rollbackId,
        );
        expect(rollback['action'], 'rollback');
        expect(rollback['restored'], rollbackBefore);
        final forget = memoryPreview.singleWhere(
          (item) => obj(item['entry'])['content'] == onlyProject,
        );
        expect(forget['action'], 'forget');
        final review = memoryPreview.singleWhere(
          (item) => obj(item['entry'])['id'] == mixedId,
        );
        expect(review['action'], 'review');
        final reviewRevision = (obj(review['entry'])['revision'] as num)
            .toInt();

        final theme = await PircTheme.load();
        final dialogClosed = Completer<bool?>();
        await t.pumpWidget(
          MaterialApp(
            theme: theme.build(Brightness.light),
            home: Builder(
              builder: (context) => Scaffold(
                body: Center(
                  child: TextButton(
                    key: const Key('project-deletion-test-open'),
                    onPressed: () {
                      unawaited(
                        deleteProjectDialog(context, c, project).then((result) {
                          if (!dialogClosed.isCompleted) {
                            dialogClosed.complete(result);
                          }
                        }),
                      );
                    },
                    child: const Text('Open project deletion'),
                  ),
                ),
              ),
            ),
          ),
        );
        await t.tap(find.byKey(const Key('project-deletion-test-open')));
        await t.pump();
        const confirmKey = Key('project-deletion-confirm');
        await until(
          () =>
              find.byKey(confirmKey).evaluate().isNotEmpty &&
              find.text('Needs your decision').evaluate().isNotEmpty,
          'the real project deletion dialog loads its preview',
        );
        expect(
          find.textContaining(project['displayName'] as String),
          findsOneWidget,
        );
        expect(find.textContaining('1 chat'), findsWidgets);
        expect(find.byKey(Key('project-memory-$mixedId-edit')), findsOneWidget);
        expect(find.textContaining(rollbackProject), findsOneWidget);
        expect(find.textContaining(rollbackBefore), findsOneWidget);

        await expectLater(
          gateway.request(
            deletionPath,
            method: 'POST',
            pairingStamp: 'stale-native-pairing-stamp',
            body: const {'decisions': []},
          ),
          throwsA(
            isA<PlatformException>().having(
              (error) => error.code,
              'code',
              'HTTP_409',
            ),
          ),
          reason: 'A stale pairing stamp cannot authorize project deletion.',
        );
        expect(
          rows(
            (await gateway.request('/api/workspaces'))['workspaces'],
          ).any((workspace) => workspace['id'] == currentProjectId),
          isTrue,
          reason: 'A rejected stale pairing stamp leaves the project intact.',
        );

        final editKey = Key('project-memory-$mixedId-edit');
        final textKey = Key('project-memory-$mixedId-text');
        await t.ensureVisible(find.byKey(editKey));
        await t.tap(find.byKey(editKey));
        await t.pump();
        await t.ensureVisible(find.byKey(textKey));
        await t.enterText(find.byKey(textKey), 'Draft that must be reset');

        await writeNoteFromChat(
          sessionId: mixedWriterId,
          command:
              '/parity-project-memory-replace $mixedId $mixedAfterConflict',
          expectedContent: mixedAfterConflict,
        );
        expect(
          (obj(await waitForNote(mixedAfterConflict))['revision'] as num)
              .toInt(),
          greaterThan(reviewRevision),
        );

        await t.ensureVisible(find.byKey(confirmKey));
        await t.tap(find.byKey(confirmKey));
        await t.pump();
        await until(
          () =>
              find.textContaining(mixedAfterConflict).evaluate().isNotEmpty &&
              find.byKey(textKey).evaluate().isEmpty,
          '409 reloads the preview and clears stale memory choices',
        );
        expect(find.textContaining('Draft that must be reset'), findsNothing);

        const finalReviewedText = 'Deletion mixed user-reviewed result';
        await t.ensureVisible(find.byKey(editKey));
        await t.tap(find.byKey(editKey));
        await t.pump();
        await t.ensureVisible(find.byKey(textKey));
        await t.enterText(find.byKey(textKey), finalReviewedText);
        await t.ensureVisible(find.byKey(confirmKey));
        await t.tap(find.byKey(confirmKey));
        await t.pump();
        expect(
          await dialogClosed.future.timeout(const Duration(seconds: 30)),
          isTrue,
          reason: 'Confirming the refreshed memory review deletes the project.',
        );
        projectDeleted = true;

        await c.refreshList();
        await c.attention.refreshMemory();
        expect(
          c.workspaces.any((workspace) => workspace['id'] == currentProjectId),
          isFalse,
        );
        expect(
          c.sessions.any((session) => session['id'] == projectChatId),
          isFalse,
        );
        expect(
          c.sessions.any((session) => session['id'] == topChatId),
          isTrue,
          reason: 'Deleting a project preserves chats in top-level Chats.',
        );

        final remainingWorkspaces = rows(
          (await gateway.request('/api/workspaces'))['workspaces'],
        );
        expect(
          remainingWorkspaces.any(
            (workspace) => workspace['id'] == currentProjectId,
          ),
          isFalse,
        );
        expect(remainingWorkspaces.any(c.catalog.topChats), isTrue);
        final remainingSessions = rows(
          (await gateway.request('/api/sessions'))['sessions'],
        );
        expect(
          remainingSessions.any((session) => session['id'] == projectChatId),
          isFalse,
        );
        expect(
          remainingSessions.any((session) => session['id'] == topChatId),
          isTrue,
        );
        await expectLater(
          gateway.request('/api/workspaces/${enc(currentProjectId)}/files'),
          throwsA(
            isA<PlatformException>().having(
              (error) => error.code,
              'code',
              'HTTP_404',
            ),
          ),
          reason: 'Project files are removed with their project.',
        );
        await expectLater(
          gateway.request(
            '/api/workspaces/${enc(currentProjectId)}/instructions',
          ),
          throwsA(
            isA<PlatformException>().having(
              (error) => error.code,
              'code',
              'HTTP_404',
            ),
          ),
          reason: 'Project instructions are removed with their project.',
        );
        final remainingMemory = obj(await gateway.request('/api/memory'));
        final notes = rows(remainingMemory['notes']);
        expect(
          notes.any((entry) => entry['content'] == rollbackBefore),
          isTrue,
        );
        expect(
          notes.any((entry) => entry['content'] == rollbackProject),
          isFalse,
        );
        expect(notes.any((entry) => entry['content'] == onlyProject), isFalse);
        expect(
          notes.any((entry) => entry['content'] == mixedAfterConflict),
          isFalse,
        );
        expect(
          notes.any((entry) => entry['content'] == finalReviewedText),
          isTrue,
        );
        expect(t.takeException(), isNull);
        debugPrint(
          'PROJECT_DELETION:preview rollback/review/forget, conflict refresh, pairing fence, files and project chats removed; top-level Chats preserved',
        );
      } finally {
        await t.pumpWidget(const SizedBox.shrink());
        controller?.dispose();
        try {
          await finishProjectDeletionIfNeeded();
          if (mixedWriterSessionId != null) {
            await gateway.request(
              sessionPath(mixedWriterSessionId),
              method: 'DELETE',
            );
          }
          if (topLevelSessionId != null) {
            try {
              await gateway.request(
                sessionPath(topLevelSessionId),
                method: 'DELETE',
              );
            } catch (_) {}
          }
        } finally {
          if (paired) await gateway.call('unpair');
        }
      }
    },
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
