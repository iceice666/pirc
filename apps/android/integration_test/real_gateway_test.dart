// Opt-in: isolated real gateway + chat node with the local scripted memory model.
// Pairing credentials come from a private --dart-define-from-file, never the repo.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/conversation_timeline.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/interaction_card.dart';
import 'package:pirc_mobile/theme.dart';

class IntegrationGateway extends Gateway {
  PlatformException? lastApprovalError;
  int approvalRequests = 0;
  @override
  Future<dynamic> call(String method, [Json args = const {}]) async {
    final approval =
        method == 'request' &&
        args['method'] == 'POST' &&
        '${args['path']}'.endsWith('/approve');
    if (approval) approvalRequests++;
    try {
      return await super.call(method, args);
    } on PlatformException catch (e) {
      if (approval) lastApprovalError = e;
      if (method == 'answer') {
        debugPrint(
          'REAL_GATEWAY:answer-error=${e.code}/${obj(e.details)['code']} ${e.message}',
        );
      }
      rethrow;
    }
  }
}

List<Json> flattenTools(Iterable<Json> tools) {
  final flattened = <Json>[];
  void visit(Json tool) {
    flattened.add(tool);
    for (final operation in rows(tool['operations'])) {
      visit(operation);
    }
  }

  for (final tool in tools) {
    visit(tool);
  }
  return flattened;
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'real gateway: bearer, stream, memory, schedules, deletion',
    (t) async {
      expect(
        const bool.fromEnvironment('PIRC_REAL_GATEWAY'),
        isTrue,
        reason: 'Only run against an isolated local test environment.',
      );
      const link = String.fromEnvironment('PIRC_PAIR_LINK');
      expect(link.isNotEmpty, isTrue, reason: 'Missing private pairing link.');
      final g = IntegrationGateway();
      await g.call('pair', {'link': link});
      await g.call('completeOnboarding');
      final originalPreferences = obj(await g.call('preferences'));
      await g.call('savePreferences', {
        'goalExpanded': true,
        'todoExpanded': true,
      });
      final persistedDock = obj(await g.call('preferences'));
      expect(persistedDock['goalExpanded'], true);
      expect(persistedDock['todoExpanded'], true);
      await g.call('savePreferences', {
        ...originalPreferences,
        'appearance': 'light',
        'mode': 'chat',
      });
      // This fails if a development proxy accidentally authenticates the app as a browser.
      await expectLater(
        g.request('/api/devices'),
        throwsA(
          isA<PlatformException>().having((e) => e.code, 'code', 'HTTP_403'),
        ),
      );
      final observed = <Json>[];
      final observations = g.events.listen(observed.add);
      final c = LiveController(g);
      final theme = await PircTheme.load();
      String? createdChat, createdSchedule;
      Future<void> until(bool Function() ready, String step) async {
        for (var i = 0; i < 200 && !ready(); i++) {
          await t.pump(const Duration(milliseconds: 200));
        }
        if (!ready()) {
          debugPrint(
            'REAL_GATEWAY:pending=${c.questions.map((q) => [q['kind'], q['status']]).toList()} canWrite=${c.canWrite} busy=${c.busy}',
          );
        }
        expect(
          ready(),
          isTrue,
          reason:
              '$step: ${c.error ?? c.actionError ?? c.attention.memoryError ?? c.connection}',
        );
        expect(t.takeException(), isNull, reason: step);
      }

      Future<void> decideInlineMemory(
        String proposalId,
        bool approve,
        List<String> description,
      ) async {
        await until(
          () =>
              c.canWrite &&
              c.questions.any(
                (q) => '${q['id']}'.startsWith('memory:$proposalId:'),
              ),
          'inline memory confirmation',
        );
        final q = c.questions.firstWhere(
          (q) => '${q['id']}'.startsWith('memory:$proposalId:'),
        );
        final card = find.byWidgetPredicate(
          (w) => w is NativeInteractionCard && w.question['id'] == q['id'],
        );
        await t.pump();
        final timeline = find
            .ancestor(
              of: find.byType(ConversationTimeline),
              matching: find.byType(CustomScrollView),
            )
            .first;
        final scrollable = find
            .descendant(of: timeline, matching: find.byType(Scrollable))
            .first;
        await t.scrollUntilVisible(
          card,
          300,
          scrollable: scrollable,
          maxScrolls: 40,
        );
        expect(card, findsOneWidget);
        for (final text in description) {
          expect('${q['description']}', contains(text));
          expect(
            find.descendant(of: card, matching: find.textContaining(text)),
            findsOneWidget,
          );
        }
        expect(
          find.descendant(
            of: card,
            matching: find.text(
              'Choose whether the agent should continue with this action.',
            ),
          ),
          findsNothing,
        );
        final button = find.descendant(
          of: card,
          matching: find.widgetWithText(
            TextButton,
            approve ? 'Approve' : 'Reject',
          ),
        );
        await t.ensureVisible(button);
        await t.pump();
        expect(t.widget<TextButton>(button).onPressed, isNotNull);
        await t.tap(button);
        await until(
          () =>
              !c.questions.any(
                (q) => '${q['id']}'.startsWith('memory:$proposalId:'),
              ) &&
              !c.attention.proposals.any((p) => p['id'] == proposalId),
          'inline memory decision reflected in chat and inbox',
        );
      }

      try {
        await t.pumpWidget(MobileApp(theme: theme, controller: c));
        await until(() => !c.booting && c.workspaces.isNotEmpty, 'boot');
        expect(c.error, isNull);
        expect(c.attention.memoryError, isNull);
        expect(c.attention.scheduleError, isNull);
        final workspace = c.workspaces.firstWhere((w) => w['kind'] == 'chat');
        final result = await g.request(
          '/api/sessions',
          method: 'POST',
          body: {'workspaceId': workspace['id']},
        );
        createdChat = '${obj(result['session'])['id']}';
        await c.refreshList();
        await c.open(createdChat);
        await until(
          () => c.canWrite && c.models.isNotEmpty,
          'open and acquire lease',
        );
        debugPrint('REAL_GATEWAY:paired-and-writable');
        c.editDraft('/parity-question');
        await c.send('prompt');
        await until(
          () => c.canWrite && c.questions.any((q) => q['kind'] == 'select'),
          'real select interaction',
        );
        await t.pumpAndSettle();
        await t.ensureVisible(find.text('Tablet'));
        await t.pumpAndSettle();
        expect(find.text('Tablet').hitTestable(), findsOneWidget);
        await t.tap(find.text('Tablet'));
        await t.pump();
        final selectSubmit = find.widgetWithText(TextButton, 'Submit');
        await t.ensureVisible(selectSubmit);
        await t.pumpAndSettle();
        expect(t.widget<TextButton>(selectSubmit).onPressed, isNotNull);
        expect(selectSubmit.hitTestable(), findsOneWidget);
        await t.tap(selectSubmit);
        await until(
          () => c.canWrite && c.questions.any((q) => q['kind'] == 'input'),
          'next text interaction',
        );
        final input = find.descendant(
          of: find.byType(NativeInteractionCard),
          matching: find.byType(TextField),
        );
        await t.pumpAndSettle();
        await t.ensureVisible(input);
        await t.pumpAndSettle();
        await t.enterText(input, '原生互動驗證');
        await t.pumpAndSettle();
        final inputSubmit = find.widgetWithText(TextButton, 'Submit');
        await t.ensureVisible(inputSubmit);
        await t.pumpAndSettle();
        expect(t.widget<TextButton>(inputSubmit).onPressed, isNotNull);
        expect(inputSubmit.hitTestable(), findsOneWidget);
        await t.tap(inputSubmit);
        await until(
          () =>
              c.questions.isEmpty &&
              !c.running &&
              c.messages
                  .expand((m) => flattenTools(rows(m['tools'])))
                  .any(
                    (tool) =>
                        tool['name'] == 'ask_user_question' &&
                        '${tool['output']}'.contains('原生互動驗證') &&
                        '${tool['output']}'.contains('Tablet'),
                  ),
          'answered interaction reaches agent tool',
        );
        debugPrint('REAL_GATEWAY:select-and-text-answers-reached-agent');
        await until(
          () => c.canWrite,
          'control available after interaction resnapshot',
        );
        final marker = 'Flutter 原生驗收 ${DateTime.now().millisecondsSinceEpoch}';
        c.editDraft('請記住：$marker，偏好繁體中文。');
        await c.send('prompt');
        expect(c.actionError, isNull);
        await until(
          () =>
              c.messages.any(
                (m) =>
                    m['role'] == 'assistant' &&
                    '${m['content']}'.contains('已呼叫記憶工具'),
              ) &&
              c.messages.any(
                (m) =>
                    m['role'] == 'user' && '${m['content']}'.contains(marker),
              ) &&
              !c.running,
          'stream scripted memory response',
        );
        expect(c.draft, isEmpty);
        expect(c.unknownCommand, isFalse);
        // Run lifecycle resets may cross a user-wide event. Reconnect refresh must recover it.
        await until(
          () => c.attention.proposals.any(
            (p) => '${p['content']}'.contains(marker),
          ),
          'memory proposal via event or reconnect refresh',
        );
        final proposal = c.attention.proposals.firstWhere(
          (p) => '${p['content']}'.contains(marker),
        );
        await decideInlineMemory('${proposal['id']}', true, [
          'Proposed memory:',
          marker,
          'Your words:',
          'Your decision is saved immediately.',
        ]);
        expect(c.attention.memoryError, isNull);
        final entry = rows(
          c.attention.memory?['user'],
        ).firstWhere((e) => '${e['content']}'.contains(marker));
        final entryId = '${entry['id']}';
        expect(await c.attention.history(entryId), isNotEmpty);
        final revised = '$marker，改為詳盡回答。';
        await until(() => c.canWrite, 'writable after memory approval');
        c.editDraft('/parity-replace $entryId $revised');
        await c.send('prompt');
        expect(c.draft, isEmpty, reason: c.actionError);
        await until(
          () =>
              c.attention.proposals.any((p) => p['targetId'] == entryId) &&
              !c.running,
          'replacement proposal',
        );
        final replacement = c.attention.proposals.firstWhere(
          (p) => p['targetId'] == entryId,
        );
        expect(obj(replacement['target'])['revision'], entry['revision']);
        await decideInlineMemory('${replacement['id']}', true, [
          'Current memory ($entryId):',
          '${entry['content']}',
          'Proposed memory:',
          revised,
          'Your words:',
        ]);
        expect(c.attention.memoryError, isNull);
        expect(
          rows(
            c.attention.memory?['user'],
          ).singleWhere((e) => e['id'] == entryId)['content'],
          revised,
        );
        final replacementRevision = rows(
          c.attention.memory?['user'],
        ).singleWhere((e) => e['id'] == entryId)['revision'];
        // On a stable idle watch, mutate through the transport alone: only the
        // native memory event may update the controller's revision/content here.
        await until(
          () => c.canWrite && !c.running,
          'stable watch for memory restore',
        );
        final beforeRestoreEvents = observed
            .where(
              (e) =>
                  e['type'] == 'indexChange' && e['data'] == 'memory_changed',
            )
            .length;
        await g.request(
          '/api/memory/entries/${enc(entryId)}/restore',
          method: 'POST',
          body: {'revision': entry['revision']},
        );
        await until(
          () =>
              observed
                      .where(
                        (e) =>
                            e['type'] == 'indexChange' &&
                            e['data'] == 'memory_changed',
                      )
                      .length >
                  beforeRestoreEvents &&
              rows(c.attention.memory?['user']).any(
                (e) => e['id'] == entryId && e['content'] == entry['content'],
              ),
          'native event refreshes restored revision',
        );
        expect(c.attention.memoryError, isNull);
        await until(() => c.canWrite, 'writable before remove proposal');
        c.editDraft('/parity-remove $entryId');
        await c.send('prompt');
        expect(c.draft, isEmpty, reason: c.actionError);
        await until(
          () =>
              c.canWrite &&
              !c.running &&
              c.questions.any((q) => q['title'] == 'Remove USER memory?') &&
              c.attention.proposals.any(
                (p) => p['action'] == 'remove' && p['targetId'] == entryId,
              ),
          'remove confirmation',
        );
        final oldRemoval = c.questions.firstWhere(
          (q) => q['title'] == 'Remove USER memory?',
        );
        final removal = c.attention.proposals.firstWhere(
          (p) => p['action'] == 'remove' && p['targetId'] == entryId,
        );
        // Changing a pending target also replaces its confirmation and can
        // reset the watch before the user-wide event arrives. Read recovery
        // is expected here; the idle event-only check above remains separate.
        await g.request(
          '/api/memory/entries/${enc(entryId)}/restore',
          method: 'POST',
          body: {'revision': replacementRevision},
        );
        // Exercise the production personal-memory decision against a real
        // changed target. The HTTP reason must survive native presentation;
        // the failed request must refresh review data without approving again.
        final approvalBefore = g.approvalRequests;
        await c.attention.decideProposal(removal, true);
        expect(g.approvalRequests, approvalBefore + 1);
        expect(g.lastApprovalError?.code, 'HTTP_409');
        expect(g.lastApprovalError?.message, isNotEmpty);
        await until(
          () =>
              !c.attention.memoryLoading &&
              c.attention.proposals.any(
                (p) =>
                    p['id'] == removal['id'] &&
                    obj(p['target'])['revision'] !=
                        obj(removal['target'])['revision'],
              ),
          'conflict review refresh completed',
        );
        expect(c.attention.memoryError, g.lastApprovalError!.message);
        expect(c.attention.memoryError, isNot('狀態已改變，請重新載入後再操作。'));
        final reviewedRemoval = c.attention.proposals.singleWhere(
          (p) => p['id'] == removal['id'],
        );
        expect(
          obj(reviewedRemoval['target'])['revision'],
          isNot(obj(removal['target'])['revision']),
        );
        expect(
          rows(
            c.attention.memory?['user'],
          ).singleWhere((e) => e['id'] == entryId)['content'],
          revised,
        );
        debugPrint(
          'REAL_GATEWAY:personal-memory-conflict-reason-and-no-replay',
        );
        // A decision from the pre-restore card must never apply to a newer target revision.
        await expectLater(
          g.call('answer', {
            'sessionId': createdChat,
            'interactionId': oldRemoval['id'],
            'pairingStamp': c.pairingStamp,
            'epoch': oldRemoval['epoch'],
            'answer': {'confirmed': true},
          }),
          throwsA(
            isA<PlatformException>().having((e) => e.code, 'code', 'HTTP_409'),
          ),
        );
        await until(
          () => c.questions.any(
            (q) =>
                '${q['id']}'.startsWith('memory:${removal['id']}:') &&
                q['id'] != oldRemoval['id'],
          ),
          'replacement confirmation after target revision changes',
        );
        await decideInlineMemory('${removal['id']}', false, [
          'Current memory ($entryId):',
          revised,
          '/parity-remove $entryId',
        ]);
        expect(
          rows(
            c.attention.memory?['user'],
          ).singleWhere((e) => e['id'] == entryId)['content'],
          revised,
        );
        debugPrint(
          'REAL_GATEWAY:inline-memory-add-replace-reject-and-stale-revision',
        );
        // Forget is permanent. Exercise it on the note, keeping USER for cascade deletion.
        final note = rows(
          c.attention.memory?['notes'],
        ).firstWhere((e) => '${e['content']}'.contains(marker));
        await c.attention.forget('${note['id']}');
        expect(c.attention.memoryError, isNull);
        expect(
          rows(c.attention.memory?['notes']).any((e) => e['id'] == note['id']),
          isFalse,
        );
        expect(
          rows(
            c.attention.memory?['removed'],
          ).any((e) => e['id'] == note['id']),
          isFalse,
        );
        await expectLater(
          g.request(
            '/api/memory/entries/${enc('${note['id']}')}/restore',
            method: 'POST',
            body: {},
          ),
          throwsA(
            isA<PlatformException>().having((e) => e.code, 'code', 'HTTP_409'),
          ),
        );
        debugPrint('REAL_GATEWAY:memory-revision-restored-and-note-forgotten');
        c.editDraft('切到背景仍保留的草稿');
        final connectionsBeforeResume = observed
            .where((e) => e['type'] == 'connection' && e['data'] == 'live')
            .length;
        await c.lifecycle(false);
        await c.lifecycle(true);
        await until(
          () =>
              c.canWrite &&
              observed
                      .where(
                        (e) => e['type'] == 'connection' && e['data'] == 'live',
                      )
                      .length >
                  connectionsBeforeResume,
          'resume reconnect and control',
        );
        expect(c.draft, '切到背景仍保留的草稿');
        final schedule = await g.request(
          '/api/schedules',
          method: 'POST',
          body: {
            'workspaceId': workspace['id'],
            'title': 'Flutter parity integration',
            'prompt': 'Native schedule transport check.',
            'cron': '0 9 * * *',
            'timezone': 'Asia/Taipei',
          },
        );
        createdSchedule = '${obj(schedule['schedule'])['id']}';
        await until(
          () => c.attention.schedules.any((s) => s['id'] == createdSchedule),
          'schedule event',
        );
        await g.request(
          '/api/schedules/${enc(createdSchedule)}',
          method: 'PATCH',
          body: {'status': 'paused'},
        );
        await until(
          () => c.attention.schedules.any(
            (s) => s['id'] == createdSchedule && s['status'] == 'paused',
          ),
          'schedule pause',
        );
        debugPrint('REAL_GATEWAY:reconnected-and-schedule-observed');
        await until(() => c.canWrite, 'writable for final memory proposal');
        c.editDraft('請記住：$marker，還有一個未核准的偏好。');
        await c.send('prompt');
        expect(c.draft, isEmpty, reason: c.actionError);
        await until(
          () =>
              !c.running &&
              c.attention.proposals.any(
                (p) => '${p['content']}'.contains(marker),
              ) &&
              rows(
                c.attention.memory?['notes'],
              ).any((e) => '${e['content']}'.contains(marker)),
          'pending proposal and note before deletion',
        );
        expect(
          rows(c.attention.memory?['user']).any((e) => e['id'] == entryId),
          isTrue,
        );
        expect(
          observed.any(
            (e) =>
                e['type'] == 'indexChange' && e['data'] == 'schedules_changed',
          ),
          isTrue,
        );
        await c.deleteChat(createdChat);
        await until(() => !c.attention.memoryLoading, 'source chat cascade');
        await c.attention.refreshMemory();
        for (final kind in ['user', 'notes', 'removed', 'proposals']) {
          expect(
            rows(
              c.attention.memory?[kind],
            ).any((e) => '${e['content']}'.contains(marker)),
            isFalse,
            reason: 'Deleted source chat retained $kind',
          );
        }
        expect(c.sessionId, isNull);
        expect(c.sessions.any((s) => s['id'] == createdChat), isFalse);
        createdChat = null;
        debugPrint('REAL_GATEWAY:source-chat-and-memory-deleted');
        expect(t.takeException(), isNull);
      } finally {
        // Delete only resources created by this test, even after a failed assertion.
        if (createdSchedule != null) {
          await g.request(
            '/api/schedules/${enc(createdSchedule)}',
            method: 'DELETE',
          );
        }
        if (createdChat != null) {
          await g.request(sessionPath(createdChat), method: 'DELETE');
        }
        await t.pumpWidget(const SizedBox());
        await g.call('unwatch');
        await observations.cancel();
      }
    },
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
