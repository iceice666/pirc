// Opt-in acceptance for native PTC operation timelines and linked interactions.
// Start the isolated real gateway/model with the /parity-ptc prompt and pass
// its private pairing link through --dart-define-from-file.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/interaction_card.dart';
import 'package:pirc_mobile/live/timeline_tools.dart';
import 'package:pirc_mobile/theme.dart';

String messageText(Json message) {
  final content = message['content'];
  if (content is String) return content;
  if (content is List) {
    return content.map((part) {
      final item = obj(part);
      return '${item['text'] ?? item['thinking'] ?? ''}';
    }).join();
  }
  return '';
}

List<Json> nestedTools(List<Json> messages) {
  final result = <Json>[];
  void visit(Json tool) {
    result.add(tool);
    for (final operation in rows(tool['operations'])) {
      visit(operation);
    }
  }

  for (final message in messages) {
    for (final tool in rows(message['tools'])) {
      visit(tool);
    }
  }
  return result;
}

Json? toolByName(List<Json> messages, String name) {
  for (final tool in nestedTools(messages)) {
    if (tool['name'] == name) return tool;
  }
  return null;
}

Json? toolById(List<Json> messages, String id) {
  for (final tool in nestedTools(messages)) {
    if (tool['id'] == id) return tool;
  }
  return null;
}

Json? ptcQuestion(List<Json> interactions) {
  for (final interaction in interactions) {
    if (interaction['status'] == 'pending' &&
        interaction['kind'] == 'select' &&
        '${interaction['title']}'.contains('PTC verification?')) {
      return interaction;
    }
  }
  return null;
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'real Android gateway keeps nested PTC operations and approval linked after reconnect',
    (tester) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      const pairingLink = String.fromEnvironment('PIRC_PAIR_LINK');
      expect(pairingLink, isNotEmpty, reason: 'Missing private pairing link.');

      final gateway = Gateway();
      LiveController? controller;
      Json? originalPreferences;
      String? createdChat;
      var paired = false;

      Future<void> until(bool Function() ready, String label) async {
        for (var i = 0; i < 900 && !ready(); i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        expect(
          ready(),
          isTrue,
          reason:
              '$label: ${controller?.error ?? controller?.actionError ?? controller?.connection}',
        );
        await tester.pump();
        expect(tester.takeException(), isNull, reason: label);
      }

      Future<Json> snapshotUntil(
        String sessionId,
        bool Function(Json) ready,
        String label,
      ) async {
        Json latest = {};
        for (var i = 0; i < 900; i++) {
          // Use a fresh native snapshot call, independent of LiveController state.
          latest = obj(await gateway.call('refresh', {'sessionId': sessionId}));
          if (ready(latest)) return latest;
          await tester.pump(const Duration(milliseconds: 100));
        }
        fail('$label: run=${obj(latest['run'])}');
      }

      void expectPtcSnapshot(Json snapshot, {required String label}) {
        final messages = rows(snapshot['messages']);
        final parent = toolByName(messages, 'ptc');
        expect(
          parent,
          isNotNull,
          reason: '$label did not include the PTC call.',
        );
        final children = rows(obj(parent)['operations']);
        expect(
          children.any((tool) => tool['name'] == 'read'),
          isTrue,
          reason: '$label did not retain the completed README read operation.',
        );
        final read = children.firstWhere((tool) => tool['name'] == 'read');
        expect(read['status'], 'succeeded', reason: label);
        expect('${read['output']}', isNotEmpty, reason: label);
        final ask = children.firstWhere(
          (tool) => tool['name'] == 'ask_user_question',
          orElse: () => <String, dynamic>{},
        );
        expect(
          ask,
          isNotEmpty,
          reason: '$label missed the waiting question operation.',
        );
        final question = ptcQuestion(rows(snapshot['interactions']));
        expect(
          question,
          isNotNull,
          reason: '$label missed the pending question.',
        );
        expect(
          obj(question)['toolCallId'],
          ask['id'],
          reason:
              '$label did not associate the question with its nested operation.',
        );
      }

      try {
        await gateway.call('pair', {'link': pairingLink});
        paired = true;
        await gateway.call('completeOnboarding');
        originalPreferences = obj(await gateway.call('preferences'));

        final c = controller = LiveController(gateway);
        await tester.pumpWidget(
          MobileApp(theme: await PircTheme.load(), controller: c),
        );
        await until(() => !c.booting && c.workspaces.isNotEmpty, 'app boot');
        expect(c.error, isNull);

        final workspace = c.workspaces.firstWhere((w) => w['kind'] == 'chat');
        final created = await gateway.request(
          '/api/sessions',
          method: 'POST',
          body: {'workspaceId': workspace['id']},
        );
        createdChat = '${obj(created['session'])['id']}';
        await c.refreshList();
        await c.open(createdChat);
        await until(
          () => c.canWrite && c.models.isNotEmpty,
          'chat write lease',
        );

        c.editDraft('/parity-ptc');
        await c.send('prompt');
        expect(c.actionError, isNull, reason: c.actionError);
        await until(
          () => ptcQuestion(c.questions) != null,
          'PTC question awaits a native answer',
        );
        await until(
          () =>
              toolByName(c.messages, 'read')?['status'] == 'succeeded' &&
              toolByName(c.messages, 'ask_user_question')?['status'] ==
                  'running',
          'read operation completes before ask_user_question waits',
        );

        final beforeReconnect = await snapshotUntil(
          createdChat,
          (snapshot) => ptcQuestion(rows(snapshot['interactions'])) != null,
          'independent pending snapshot',
        );
        expectPtcSnapshot(beforeReconnect, label: 'snapshot');
        expect(obj(beforeReconnect['run'])['status'], 'waiting_input');

        final liveRead = toolByName(c.messages, 'read');
        expect(liveRead, isNotNull);
        expect('${obj(liveRead)['output']}', isNotEmpty);
        final liveAsk = toolByName(c.messages, 'ask_user_question');
        expect(liveAsk, isNotNull);
        expect(obj(liveAsk)['status'], 'running');

        await c.lifecycle(false);
        await c.lifecycle(true);
        await until(
          () =>
              c.connection == 'live' &&
              c.canWrite &&
              ptcQuestion(c.questions) != null &&
              toolByName(c.messages, 'ask_user_question')?['status'] ==
                  'running',
          'reconnect restores the pending question and nested operation',
        );
        final afterReconnect = await snapshotUntil(
          createdChat,
          (snapshot) => ptcQuestion(rows(snapshot['interactions'])) != null,
          'snapshot after reconnect',
        );
        expectPtcSnapshot(afterReconnect, label: 'reconnected snapshot');

        final question = ptcQuestion(c.questions)!;
        final operationId = '${question['toolCallId']}';
        expect(operationId, isNotEmpty);
        final card = find.byWidgetPredicate(
          (widget) =>
              widget is NativeInteractionCard &&
              widget.question['id'] == question['id'],
        );
        final linkedOperation = find.byWidgetPredicate(
          (widget) =>
              widget is TimelineTool && widget.tool['id'] == operationId,
        );
        await until(
          () =>
              card.evaluate().isNotEmpty &&
              linkedOperation.evaluate().isNotEmpty,
          'linked interaction is presented inside its nested operation card',
        );
        expect(card, findsOneWidget);
        expect(linkedOperation, findsOneWidget);
        expect(
          find.descendant(of: linkedOperation, matching: card),
          findsOneWidget,
          reason:
              'The question should be inside the operation it is waiting on.',
        );
        expect(
          rows(
            question['options'],
          ).any((option) => option['label'] == 'Continue'),
          isTrue,
        );
        final continueOption = find.descendant(
          of: card,
          matching: find.widgetWithText(InkWell, 'Continue'),
        );
        expect(continueOption, findsOneWidget);
        await tester.ensureVisible(continueOption);
        expect(continueOption.hitTestable(), findsOneWidget);
        await tester.tap(continueOption);
        await tester.pump();

        final submit = find.descendant(
          of: card,
          matching: find.widgetWithText(TextButton, 'Submit'),
        );
        await tester.ensureVisible(submit);
        expect(tester.widget<TextButton>(submit).onPressed, isNotNull);
        await tester.tap(submit);
        await until(
          () =>
              !c.running &&
              c.questions.isEmpty &&
              c.messages.any(
                (message) =>
                    message['role'] == 'assistant' &&
                    messageText(message).contains('PTC_VERIFIED'),
              ),
          'Continue reaches the model and the PTC run completes',
        );

        final completed = obj(
          await gateway.call('refresh', {'sessionId': createdChat}),
        );
        expect(
          rows(completed['messages']).any(
            (message) =>
                message['role'] == 'assistant' &&
                messageText(message).contains('PTC_VERIFIED'),
          ),
          isTrue,
          reason: 'The final marker must be persisted in the gateway snapshot.',
        );
        expect(obj(completed['run'])['status'], 'succeeded');
        final completedParent = toolByName(rows(completed['messages']), 'ptc');
        expect(completedParent, isNotNull);
        expect(obj(completedParent)['status'], 'succeeded');
        final completedRead = toolByName(rows(completed['messages']), 'read');
        expect(completedRead, isNotNull);
        expect(obj(completedRead)['status'], 'succeeded');
        expect('${obj(completedRead)['output']}', isNotEmpty);
        final completedAsk = toolByName(
          rows(completed['messages']),
          'ask_user_question',
        );
        expect(completedAsk, isNotNull);
        expect(obj(completedAsk)['status'], 'succeeded');
        expect('${obj(completedAsk)['output']}', contains('Continue'));

        expect(tester.takeException(), isNull);
      } finally {
        // LiveShell owns and disposes its controller when unmounted.
        await tester.pumpWidget(const SizedBox.shrink());
        try {
          await gateway.call('unwatch');
        } catch (_) {
          // Cleanup continues even when the watch was already dropped.
        }
        try {
          if (createdChat != null) {
            await gateway.request(sessionPath(createdChat), method: 'DELETE');
          }
        } finally {
          try {
            if (originalPreferences != null) {
              await gateway.call('savePreferences', originalPreferences);
            }
          } finally {
            if (paired) await gateway.call('unpair');
          }
        }
      }
    },
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
