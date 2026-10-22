// Real Gateway/App UI acceptance for queued steering and stopping a live run.
// Start real_gateway.ts with --run-control and pass its private defines file.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/theme.dart';

class _RecordingGateway extends Gateway {
  final commands = <Json>[];

  @override
  Future<dynamic> call(String method, [Json args = const {}]) {
    if (method == 'command') commands.add(obj(args['payload']));
    return super.call(method, args);
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'real UI selects a model, steers a running chat, stops a run, then sends again',
    (tester) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      expect(
        const bool.fromEnvironment('PIRC_RUN_CONTROL'),
        isTrue,
        reason: 'Start the isolated helper with --run-control.',
      );
      const pairingLink = String.fromEnvironment('PIRC_PAIR_LINK');
      expect(pairingLink, isNotEmpty, reason: 'Missing private pairing link.');

      final gateway = _RecordingGateway();
      LiveController? controller;
      String? sessionId;
      var paired = false;
      const holdMarker = 'RUN_CONTROL_HOLD_MARKER';
      const steeredReply = 'RUN_CONTROL_STEERED_REPLY';
      const postStopReply = 'RUN_CONTROL_POST_STOP_REPLY';
      const holdPrompt = '/parity-hold first-run';
      const steerPrompt = '/parity-steered';
      const stopPrompt = '/parity-hold stop-run';
      const afterStopPrompt = '/parity-after-stop';

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

      bool hasMessage(LiveController c, String role, String text) =>
          c.messages.any(
            (message) =>
                message['role'] == role && messageText(message).contains(text),
          );

      int holdReplyCount(LiveController c) => c.messages
          .where(
            (message) =>
                message['role'] == 'assistant' &&
                messageText(message).contains(holdMarker),
          )
          .length;

      bool terminalRun(Json run) => !const {
        'queued',
        'running',
        'waiting_input',
        'stopping',
      }.contains(run['status']);

      Future<void> until(bool Function() ready, String label) async {
        for (var i = 0; i < 450 && !ready(); i++) {
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

      Future<void> tap(Finder target) async {
        expect(target, findsOneWidget);
        await tester.ensureVisible(target);
        expect(target.hitTestable(), findsOneWidget);
        await tester.tap(target);
        await tester.pump(const Duration(milliseconds: 100));
        expect(tester.takeException(), isNull);
      }

      Future<void> sendFromComposer(String text, String tooltip) async {
        final draft = find.byKey(const Key('live-draft'));
        expect(draft, findsOneWidget);
        await tester.ensureVisible(draft);
        await tester.enterText(draft, text);
        await tester.pump();
        await tap(find.byTooltip(tooltip));
      }

      Future<Json> waitForSnapshot(
        String path,
        bool Function(Json snapshot) ready,
        String label,
      ) async {
        Json latest = {};
        for (var i = 0; i < 300; i++) {
          latest = await gateway.request(path);
          if (ready(latest)) return latest;
          await tester.pump(const Duration(milliseconds: 100));
        }
        fail('$label: ${jsonEncode(obj(latest['run']))}');
      }

      try {
        await gateway.call('pair', {'link': pairingLink});
        paired = true;
        await gateway.call('completeOnboarding');

        final c = controller = LiveController(gateway, showing: 'engine');
        await tester.pumpWidget(
          MobileApp(theme: await PircTheme.load(), controller: c),
        );
        await until(() => !c.booting, 'paired app boot');
        await until(
          () => find.text('New chat').evaluate().isNotEmpty,
          'chat creation control is visible',
        );
        await tap(find.text('New chat'));
        await until(
          () => c.sessionId != null && c.canWrite,
          'create a disposable chat through the app UI',
        );
        sessionId = c.sessionId;
        await until(
          () =>
              c.models.any((model) => model['id'] == 'native-test-run-control'),
          'run-control-only second model is available',
        );

        final secondModel = c.models.singleWhere(
          (model) => model['id'] == 'native-test-run-control',
        );
        final modelLabel =
            '${secondModel['displayName'] ?? secondModel['name'] ?? secondModel['id']}';
        await tap(find.byTooltip('Model'));
        final modelOption = find.widgetWithText(MenuItemButton, modelLabel);
        await until(() => modelOption.evaluate().isNotEmpty, 'open model menu');
        await tap(modelOption);
        await until(
          () =>
              c.selectedModel?['id'] == 'native-test-run-control' &&
              gateway.commands.any(
                (command) =>
                    command['type'] == 'set_model' &&
                    command['modelId'] == 'native-test-run-control',
              ),
          'select the second model through the composer UI',
        );
        final chatSnapshotPath = '${sessionPath(sessionId!)}/snapshot';
        final selectedModelSnapshot = await waitForSnapshot(
          chatSnapshotPath,
          (snapshot) =>
              obj(obj(snapshot['agent'])['model'])['id'] ==
              'native-test-run-control',
          'active backend applies the selected model',
        );
        expect(
          obj(obj(selectedModelSnapshot['agent'])['model'])['id'],
          'native-test-run-control',
          reason: 'The active backend must report the selected second model.',
        );

        await sendFromComposer(holdPrompt, 'Send message');
        await until(
          () => c.running && hasMessage(c, 'assistant', holdMarker),
          'hold prompt starts a visible, still-running model stream',
        );
        expect(hasMessage(c, 'user', holdPrompt), isTrue);
        expect(
          c.state['modelId'],
          'native-test-run-control',
          reason:
              'Watched snapshots after streamed messages must retain the accepted model.',
        );
        expect(c.state['modelProvider'], 'local');

        await sendFromComposer(steerPrompt, 'Send message');
        final sendNow = find.byTooltip('Send now: $steerPrompt');
        await until(
          () => sendNow.evaluate().isNotEmpty,
          'steer is persisted and appears in the visible queue',
        );
        expect(c.running, isTrue);
        await tap(sendNow);
        await until(
          () => !c.running && hasMessage(c, 'assistant', steeredReply),
          'Send now delivers the queued steer and the following model call completes',
        );
        expect(hasMessage(c, 'user', steerPrompt), isTrue);

        final path = chatSnapshotPath;
        final afterSteer = await gateway.request(path);
        final steeredHistory = rows(afterSteer['history']);
        expect(
          steeredHistory.any(
            (message) =>
                message['role'] == 'user' &&
                messageText(message).contains(holdPrompt),
          ),
          isTrue,
          reason: 'The original prompt must be persisted by the gateway/node.',
        );
        expect(
          steeredHistory.any(
            (message) =>
                message['role'] == 'user' &&
                messageText(message).contains(steerPrompt),
          ),
          isTrue,
          reason: 'The steer must be persisted as a user message.',
        );
        expect(
          steeredHistory.any(
            (message) =>
                message['role'] == 'assistant' &&
                messageText(message).contains(steeredReply),
          ),
          isTrue,
          reason:
              'The completed response must be visible in persistent history.',
        );
        expect(obj(afterSteer['run'])['status'], 'succeeded');

        final priorHoldReplies = holdReplyCount(c);
        await sendFromComposer(stopPrompt, 'Send message');
        await until(
          () => c.running && holdReplyCount(c) > priorHoldReplies,
          'second hold prompt starts another visible run',
        );
        await tap(find.byTooltip('Stop run'));
        final stopped = await waitForSnapshot(
          path,
          (snapshot) =>
              terminalRun(obj(snapshot['run'])) && !c.running && c.canWrite,
          'stop command produces a terminal real run state',
        );
        final stoppedRun = obj(stopped['run']);
        expect(stoppedRun, isNotEmpty);
        expect(const {
          'succeeded',
          'failed',
          'cancelled',
          'interrupted',
        }, contains(stoppedRun['status']));
        expect(c.canWrite, isTrue);
        expect(
          gateway.commands.any((command) => command['type'] == 'stop'),
          isTrue,
          reason:
              'The run must be stopped through the visible composer action.',
        );

        await sendFromComposer(afterStopPrompt, 'Send message');
        await until(
          () => !c.running && hasMessage(c, 'assistant', postStopReply),
          'composer accepts and completes a new message after stop',
        );
        expect(hasMessage(c, 'user', afterStopPrompt), isTrue);
        expect(
          gateway.commands.any((command) => command['type'] == 'prompt'),
          isTrue,
        );
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        try {
          await gateway.call('unwatch');
        } finally {
          try {
            if (sessionId != null) {
              await gateway.request(sessionPath(sessionId), method: 'DELETE');
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
