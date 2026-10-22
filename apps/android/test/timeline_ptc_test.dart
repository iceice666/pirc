import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/conversation_timeline.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/interaction_card.dart';
import 'package:pirc_mobile/live/timeline_tools.dart';
import 'package:pirc_mobile/live/timeline_models.dart';
import 'live_test.dart' show FakeGateway, theme;

Json fixture() => obj(
  jsonDecode(
    File('../../fixtures/timeline/ptc-operations.json').readAsStringSync(),
  ),
);

Json stateFor(Json expected) => {
  'messages': rows(expected['messages']),
  'interactions': [
    for (final question in rows(expected['interactions']))
      {...question, 'epoch': expected['runnerEpoch']},
  ],
};

Json withLiveOperationResult(Json expected, Json event) {
  final result = obj(event['result']);
  final details = obj(result['details']);
  final output = rows(
    result['content'],
  ).map((block) => (obj(block)['text'] ?? '').toString()).join();
  Json updateTool(Json tool) {
    if (tool['id'] == event['toolCallId']) {
      return {
        ...tool,
        'status': event['isError'] == true ? 'failed' : 'succeeded',
        'output': output,
        if (details['diff'] != null) 'diff': details['diff'],
      };
    }
    final operations = rows(tool['operations']);
    if (operations.isEmpty) return tool;
    return {
      ...tool,
      'operations': [for (final operation in operations) updateTool(operation)],
    };
  }

  return {
    ...expected,
    'messages': [
      for (final message in rows(expected['messages']))
        {
          ...message,
          'tools': [
            for (final tool in rows(message['tools'])) updateTool(tool),
          ],
        },
    ],
  };
}

Widget shell(LiveController controller) => MaterialApp(
  theme: theme.build(Brightness.light),
  home: Scaffold(
    body: ListenableBuilder(
      listenable: controller,
      builder: (_, _) => SingleChildScrollView(
        padding: const EdgeInsets.all(14),
        child: ConversationTimeline(controller: controller),
      ),
    ),
  ),
);

void main() {
  testWidgets(
    'snapshot, live, and final PTC operations stay native and associated',
    (tester) async {
      final expected = obj(fixture()['expected']);
      final snapshot = obj(expected['afterSnapshot']);
      final gateway = FakeGateway();
      final controller = LiveController(gateway, showing: 'engine')
        ..sessionId = 's2'
        ..connection = 'live'
        ..control = {'held': true}
        ..state = stateFor(snapshot);

      expect(timelineHasTool(controller.visibleMessages, 'p1x:op2'), isTrue);
      expect(
        timelineHasTool(controller.visibleMessages, 'unknown-ptc'),
        isFalse,
      );
      expect(timelineHasTool([], 'p1x:op2'), isFalse);
      final linkedQuestion = controller.questions.single;
      expect(
        timelineInteractionsNotEmbedded(
          controller.visibleMessages,
          controller.questions,
        ),
        isEmpty,
      );
      controller.hiddenMessages = controller.messages.length;
      expect(
        timelineInteractionsNotEmbedded(
          controller.visibleMessages,
          controller.questions,
        ),
        [linkedQuestion],
        reason:
            'A question stays visible if history truncation hides its tool.',
      );
      controller.hiddenMessages = 0;
      final snapshotTool = rows(
        rows(
          snapshot['messages'],
        ).firstWhere((message) => message['id'] == 'assistant-2000')['tools'],
      ).single;
      final snapshotSummary = RunSummary([snapshotTool]);
      expect(snapshotSummary.count, 2);
      expect(snapshotSummary.status, 'running');
      expect(snapshotSummary.title, 'Made changes');
      expect(snapshotSummary.files, ['a.ts']);
      expect(toolDescription(snapshotTool), '2 operations');

      await tester.pumpWidget(shell(controller));
      await tester.pumpAndSettle();
      expect(find.text('ptc'), findsOneWidget);
      expect(find.text('read'), findsOneWidget);
      expect(find.text('edit'), findsOneWidget);
      // The fixture still carries this pending review after the tool events.
      expect(find.text('Allow edit?'), findsOneWidget);
      expect(find.text('Your input is needed'), findsOneWidget);
      expect(find.byTooltip('Running'), findsAtLeastNWidgets(1));
      // The operation with no known PTC parent remains a normal visible tool.
      expect(find.text('ls'), findsOneWidget);

      await tester.tap(find.text('ptc'));
      await tester.pumpAndSettle();
      expect(find.text('Allow edit?'), findsOneWidget);

      await tester.tap(find.text('read'));
      await tester.pumpAndSettle();
      expect(find.text('1\tconst foo = 1;'), findsOneWidget);

      final liveEvent = obj(rows(fixture()['events']).first['data']);
      controller.state = stateFor(withLiveOperationResult(snapshot, liveEvent));
      controller.changed();
      await tester.pumpAndSettle();
      expect(find.text('Edited a.ts (1 replacement)'), findsOneWidget);
      expect(find.text('Diff'), findsOneWidget);
      expect(find.byTooltip('Done'), findsAtLeastNWidgets(1));

      final finalState = obj(expected['afterEvents']);
      controller.state = stateFor(finalState);
      controller.changed();
      await tester.pumpAndSettle();

      expect(find.text('Allow edit?'), findsOneWidget);
      expect(find.text('Edited a.ts (1 replacement)'), findsOneWidget);
      expect(find.text('Diff'), findsOneWidget);
      expect(find.text('1 fail\n[exit 1]'), findsOneWidget);
      expect(find.byTooltip('Failed'), findsAtLeastNWidgets(1));
      expect(find.text('ls'), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets(
    'pending PTC input Submit remains hittable on a phone with the keyboard open',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 844);
      tester.view.viewInsets = const FakeViewPadding(bottom: 300);
      addTearDown(tester.view.reset);

      final snapshot = obj(obj(fixture()['expected'])['afterSnapshot']);
      final longCode = List.generate(
        120,
        (index) => 'const operationLine$index = "PTC nested operation";',
      ).join('\n');
      expect(longCode.length, greaterThan(420));
      final askOperationId = 'p1x:ask-input';
      final messages = [
        for (final message in rows(snapshot['messages']))
          {
            ...message,
            'tools': [
              for (final tool in rows(message['tools']))
                if (tool['name'] == 'ptc')
                  {
                    ...tool,
                    'input': {'code': longCode},
                    'operations': [
                      for (final operation in rows(tool['operations']))
                        if (operation['name'] == 'read') operation,
                      {
                        'id': askOperationId,
                        'name': 'ask_user_question',
                        'status': 'running',
                        'input': {
                          'questions': [
                            {'question': 'PTC verification?'},
                          ],
                        },
                      },
                    ],
                  }
                else
                  tool,
            ],
          },
      ];
      final gateway = FakeGateway();
      final controller = LiveController(gateway, showing: 'engine')
        ..sessionId = 's2'
        ..origin = 'https://gateway.test'
        ..pairingStamp = 'pairing-stamp'
        ..connection = 'live'
        ..control = {'held': true}
        ..state = {
          'messages': messages,
          'interactions': [
            {
              'id': 'i-ptc-input',
              'epoch': snapshot['runnerEpoch'],
              'kind': 'input',
              'status': 'pending',
              'title': 'PTC verification?',
              'description': 'Reply to continue the nested PTC operation.',
              'toolCallId': askOperationId,
              'placeholder': 'Your answer',
            },
          ],
        };

      await tester.pumpWidget(shell(controller));
      await tester.pumpAndSettle();

      final parentTool = find.byWidgetPredicate(
        (widget) => widget is TimelineTool && widget.tool['id'] == 'p1',
      );
      final askTool = find.byWidgetPredicate(
        (widget) =>
            widget is TimelineTool && widget.tool['id'] == askOperationId,
      );
      final submit = find.widgetWithText(TextButton, 'Submit');
      expect(parentTool, findsOneWidget);
      expect(askTool, findsOneWidget);
      expect(find.byType(NativeInteractionCard), findsOneWidget);
      expect(submit, findsOneWidget);
      expect(
        tester.getSize(parentTool).height,
        greaterThan(420),
        reason: 'The long PTC source must exceed the old nested tool viewport.',
      );
      expect(tester.widget<TextButton>(submit).onPressed, isNotNull);

      await tester.ensureVisible(submit);
      await tester.pumpAndSettle();
      expect(
        submit.hitTestable(),
        findsOneWidget,
        reason:
            'The pending answer must scroll with the phone conversation, not remain clipped by a nested 420-pixel tool viewport.',
      );

      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );
}
