import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/interaction.dart';
import 'package:pirc_mobile/live/interaction_card.dart';
import 'live_test.dart' show FakeGateway, theme;

Json question(String kind) => {
  'id': 'q',
  'epoch': 'e',
  'kind': kind,
  'status': 'pending',
  'title': 'Continue?',
  'options': [
    {'value': 'a', 'label': 'Alpha', 'description': 'First option'},
    {'value': 'b', 'label': 'Beta'},
  ],
};
LiveController readyController(FakeGateway gateway) => LiveController(gateway)
  ..sessionId = 's'
  ..connection = 'live'
  ..control = {'held': true}
  ..origin = 'https://gateway.test'
  ..pairingStamp = 'test-pairing-stamp';
Widget shell(Widget child, {double scale = 1}) => MaterialApp(
  theme: theme.build(Brightness.light),
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
    child: child!,
  ),
  home: Scaffold(
    body: SingleChildScrollView(
      padding: const EdgeInsets.all(14),
      child: child,
    ),
  ),
);
void main() {
  testWidgets('question actions retain web 32px height at enlarged text', (
    t,
  ) async {
    final answers = <Json>[];
    await t.pumpWidget(
      shell(
        NativeInteractionCard(
          question: question('confirm'),
          onAnswer: (answer) async {
            answers.add(answer);
          },
        ),
        scale: 2,
      ),
    );
    await t.pumpAndSettle();
    for (final label in ['No', 'Yes, continue']) {
      final button = find.ancestor(
        of: find.text(label),
        matching: find.byType(TextButton),
      );
      expect(t.getSize(button).height, 32);
    }
    await t.tap(find.text('Yes, continue'));
    await t.pumpAndSettle();
    expect(answers.single, {'confirmed': true});
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
  });
  testWidgets('option selection draws inside the existing layout', (t) async {
    await t.pumpWidget(
      shell(
        NativeInteractionCard(
          question: question('select'),
          onAnswer: (_) async {},
        ),
      ),
    );
    await t.pumpAndSettle();
    final cardSize = t.getSize(find.byType(NativeInteractionCard));
    final labelPosition = t.getTopLeft(find.text('Alpha'));
    await t.tap(find.text('Alpha'));
    await t.pumpAndSettle();
    expect(t.getSize(find.byType(NativeInteractionCard)), cardSize);
    expect(t.getTopLeft(find.text('Alpha')), labelPosition);
    await t.sendKeyEvent(LogicalKeyboardKey.tab);
    await t.pumpAndSettle();
    expect(t.getSize(find.byType(NativeInteractionCard)), cardSize);
    expect(t.getTopLeft(find.text('Alpha')), labelPosition);
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
  });
  testWidgets('confirm decline is an answer; text cancellation is distinct', (
    t,
  ) async {
    final answers = <Json>[];
    await t.pumpWidget(
      shell(
        NativeInteractionCard(
          question: question('confirm'),
          onAnswer: (a) async {
            answers.add(a);
          },
        ),
      ),
    );
    await t.pumpAndSettle();
    await t.tap(find.text('No'));
    await t.pumpAndSettle();
    expect(answers.single, {'confirmed': false});
    await t.pumpWidget(
      shell(
        NativeInteractionCard(
          question: question('input'),
          onAnswer: (a) async {
            answers.add(a);
          },
        ),
      ),
    );
    await t.pumpAndSettle();
    await t.tap(find.text('Submit'));
    await t.pumpAndSettle();
    expect(answers.last, {'value': ''});
    await t.tap(find.text('Cancel'));
    await t.pumpAndSettle();
    expect(answers.last, {'cancelled': true});
    await t.pumpWidget(const SizedBox());
  });
  testWidgets('single choices do not deselect and arrow keys move selection', (
    t,
  ) async {
    Json? answer;
    await t.pumpWidget(
      shell(
        NativeInteractionCard(
          question: question('select'),
          onAnswer: (a) async {
            answer = a;
          },
        ),
      ),
    );
    await t.pumpAndSettle();
    await t.tap(find.text('Alpha'));
    await t.tap(find.text('Alpha'));
    await t.pumpAndSettle();
    await t.sendKeyEvent(LogicalKeyboardKey.tab);
    await t.pump();
    await t.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await t.pump();
    await t.tap(find.text('Submit'));
    await t.pumpAndSettle();
    expect(answer, {
      'values': ['b'],
    });
    await t.pumpWidget(const SizedBox());
  });
  testWidgets('multiple choices keep insertion order and can be toggled off', (
    t,
  ) async {
    Json? answer;
    await t.pumpWidget(
      shell(
        NativeInteractionCard(
          question: {...question('select'), 'multiple': true},
          onAnswer: (a) async {
            answer = a;
          },
        ),
      ),
    );
    await t.pumpAndSettle();
    await t.tap(find.text('Beta'));
    await t.tap(find.text('Alpha'));
    await t.pump();
    await t.tap(find.text('Submit'));
    await t.pumpAndSettle();
    expect(answer, {
      'values': ['b', 'a'],
    });
    await t.tap(find.text('Beta'));
    await t.tap(find.text('Submit'));
    await t.pumpAndSettle();
    expect(answer, {
      'values': ['a'],
    });
    await t.pumpWidget(const SizedBox());
  });
  testWidgets(
    'expiry locks answers and changing the question restores its own prefill',
    (t) async {
      final q = {
        ...question('editor'),
        'initialValue': 'original',
        'expiresAt': DateTime.now().millisecondsSinceEpoch + 1000,
      };
      var calls = 0;
      await t.pumpWidget(
        shell(
          NativeInteractionCard(
            question: q,
            onAnswer: (_) async {
              calls++;
            },
          ),
        ),
      );
      await t.pump();
      await t.enterText(find.byType(TextField), 'edited');
      await t.pump(const Duration(seconds: 2));
      await t.ensureVisible(find.text('Submit'));
      await t.tap(find.text('Submit'));
      await t.pump();
      expect(calls, 0);
      await t.pumpWidget(
        shell(
          NativeInteractionCard(
            question: {
              ...question('editor'),
              'id': 'next',
              'initialValue': 'next draft',
            },
            onAnswer: (_) async {
              calls++;
            },
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(find.text('next draft'), findsOneWidget);
      await t.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'inline answers hold busy, never acquire control, and unknown delivery cannot retry',
    (t) async {
      final g = FakeGateway(), c = readyController(g);
      final q = question('confirm');
      c.state = {
        'interactions': [q],
      };
      final gate = Completer<dynamic>();
      g.handler = (m, a) async => m == 'answer' ? gate.future : g.normal(m, a);
      await t.pumpWidget(
        shell(QuestionSheet(controller: c, question: q, embedded: true)),
      );
      await t.pumpAndSettle();
      await t.tap(find.text('Yes, continue'));
      await t.pump();
      await t.tap(find.text('Yes, continue'));
      await t.pump();
      expect(g.calls.where((x) => x.$1 == 'answer').length, 1);
      expect(g.calls.where((x) => x.$1 == 'control'), isEmpty);
      gate.completeError(PlatformException(code: 'HTTP_503'));
      await t.pumpAndSettle();
      await t.tap(find.text('Yes, continue'));
      await t.pump();
      expect(g.calls.where((x) => x.$1 == 'answer').length, 1);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'a fresh pending reconciliation unlocks only an explicit answer retry',
    (t) async {
      final g = FakeGateway(), c = readyController(g);
      final q = question('confirm');
      c.state = {
        'interactions': [q],
      };
      var answerCalls = 0, reconcileCalls = 0;
      g.handler = (method, args) async {
        if (method == 'answer') {
          answerCalls++;
          if (answerCalls == 1) throw PlatformException(code: 'HTTP_503');
          return null;
        }
        if (method == 'reconcileAnswer') {
          reconcileCalls++;
          return {'sessionId': 's', 'status': 'pending', 'interaction': q};
        }
        return g.normal(method, args);
      };
      await t.pumpWidget(
        shell(QuestionSheet(controller: c, question: q, embedded: true)),
      );
      await t.pumpAndSettle();

      await t.tap(find.text('Yes, continue'));
      await t.pumpAndSettle();
      expect(answerCalls, 1);
      await t.tap(find.text('Yes, continue'));
      await t.pump();
      expect(answerCalls, 1);

      await t.tap(find.text('Check latest state'));
      await t.pumpAndSettle();
      expect(reconcileCalls, 1);
      expect(
        answerCalls,
        1,
        reason: 'reconciliation must never replay the answer',
      );

      await t.tap(find.text('Yes, continue'));
      await t.pumpAndSettle();
      expect(answerCalls, 2, reason: 'the user explicitly chose to retry');
      expect(c.state['interactions'], isEmpty);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'accepted answer with a lost response resolves the card on check',
    (t) async {
      final g = FakeGateway(), c = readyController(g);
      final q = question('confirm');
      c.state = {
        'interactions': [q],
      };
      var answerCalls = 0;
      g.handler = (method, args) async {
        if (method == 'answer') {
          answerCalls++;
          throw PlatformException(code: 'HTTP_503');
        }
        if (method == 'reconcileAnswer') {
          return {'sessionId': 's', 'status': 'resolved', 'interaction': null};
        }
        return g.normal(method, args);
      };
      await t.pumpWidget(
        shell(QuestionSheet(controller: c, question: q, embedded: true)),
      );
      await t.pumpAndSettle();
      await t.tap(find.text('Yes, continue'));
      await t.pumpAndSettle();
      await t.tap(find.text('Check latest state'));
      await t.pumpAndSettle();
      expect(answerCalls, 1);
      expect(find.text('Yes, continue'), findsNothing);
      expect(c.state['interactions'], isEmpty);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'failed reconciliation keeps uncertainty; stale result preserves replacement',
    (t) async {
      final g = FakeGateway(), c = readyController(g);
      final q = question('confirm'),
          replacement = {...question('confirm'), 'epoch': 'next'};
      c.state = {
        'interactions': [q, replacement],
      };
      var answerCalls = 0, reconcileCalls = 0;
      g.handler = (method, args) async {
        if (method == 'answer') {
          answerCalls++;
          throw PlatformException(code: 'HTTP_503');
        }
        if (method == 'reconcileAnswer') {
          reconcileCalls++;
          if (reconcileCalls == 1) throw PlatformException(code: 'HTTP_503');
          return {'sessionId': 's', 'status': 'resolved', 'interaction': null};
        }
        return g.normal(method, args);
      };
      await t.pumpWidget(
        shell(QuestionSheet(controller: c, question: q, embedded: true)),
      );
      await t.pumpAndSettle();
      await t.tap(find.text('Yes, continue'));
      await t.pumpAndSettle();

      await t.tap(find.text('Check latest state'));
      await t.pumpAndSettle();
      expect(reconcileCalls, 1);
      await t.tap(find.text('Yes, continue'));
      await t.pump();
      expect(answerCalls, 1, reason: 'a failed check must leave retry blocked');

      await t.tap(find.text('Check latest state'));
      await t.pumpAndSettle();
      expect(reconcileCalls, 2);
      expect(answerCalls, 1);
      expect(c.state['interactions'], [replacement]);
      expect(find.text('Yes, continue'), findsNothing);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'an in-flight check from the previous pairing cannot clear a replacement question',
    (t) async {
      final g = FakeGateway(), c = readyController(g);
      final q = question('confirm');
      c.state = {
        'interactions': [q],
      };
      final reconciliation = Completer<dynamic>();
      Json? reconciliationArgs;
      var answerCalls = 0;
      g.handler = (method, args) async {
        if (method == 'answer') {
          answerCalls++;
          throw PlatformException(code: 'HTTP_503');
        }
        if (method == 'reconcileAnswer') {
          reconciliationArgs = args;
          return reconciliation.future;
        }
        return g.normal(method, args);
      };

      await t.pumpWidget(
        shell(QuestionSheet(controller: c, question: q, embedded: true)),
      );
      await t.pumpAndSettle();
      await t.tap(find.text('Yes, continue'));
      await t.pumpAndSettle();
      await t.tap(find.text('Check latest state'));
      await t.pump();

      expect(reconciliationArgs?['pairingStamp'], 'test-pairing-stamp');
      expect(reconciliationArgs?['origin'], 'https://gateway.test');
      expect(answerCalls, 1);

      c.origin = 'https://other-gateway.test';
      c.pairingStamp = 'replacement-pairing-stamp';
      final replacement = {...q, 'title': 'Question on the other pairing'};
      c.state = {
        'interactions': [replacement],
      };
      await t.pumpWidget(
        shell(
          QuestionSheet(controller: c, question: replacement, embedded: true),
        ),
      );

      reconciliation.complete({
        'sessionId': 's',
        'status': 'resolved',
        'interaction': null,
      });
      await t.pumpAndSettle();
      expect(find.text('Question on the other pairing'), findsOneWidget);
      expect(c.state['interactions'], [replacement]);
      expect(answerCalls, 1);

      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'an in-flight answer cannot remove the same-ID question after a pairing switch',
    (t) async {
      final g = FakeGateway(), c = readyController(g);
      final q = question('confirm'), response = Completer<dynamic>();
      Json? answerArgs;
      c.state = {
        'interactions': [q],
      };
      g.handler = (method, args) async {
        if (method == 'answer') {
          answerArgs = args;
          return response.future;
        }
        return g.normal(method, args);
      };

      await t.pumpWidget(
        shell(QuestionSheet(controller: c, question: q, embedded: true)),
      );
      await t.pumpAndSettle();
      await t.tap(find.text('Yes, continue'));
      await t.pump();
      expect(answerArgs?['pairingStamp'], 'test-pairing-stamp');

      c.origin = 'https://other-gateway.test';
      c.pairingStamp = 'replacement-pairing-stamp';
      final replacement = {...q, 'title': 'Question on the other pairing'};
      c.state = {
        'interactions': [replacement],
      };
      await t.pumpWidget(
        shell(
          QuestionSheet(controller: c, question: replacement, embedded: true),
        ),
      );

      response.complete(null);
      await t.pumpAndSettle();
      expect(find.text('Question on the other pairing'), findsOneWidget);
      expect(c.state['interactions'], [replacement]);

      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'notification refresh accepts a question whose epoch differs from the daemon cursor',
    (t) async {
      final g = FakeGateway(), c = readyController(g);
      final q = question('confirm');
      g.snapshot = {
        ...g.snapshot,
        'runnerEpoch': 'daemon-cursor',
        'interactions': [q],
      };
      await t.pumpWidget(shell(QuestionSheet(controller: c, question: q)));
      await t.pumpAndSettle();
      expect(
        t
            .widget<TextButton>(
              find.widgetWithText(TextButton, 'Yes, continue'),
            )
            .onPressed,
        isNotNull,
      );
      expect(
        g.calls.where((x) => x.$1 == 'control').single.$2['acquire'],
        false,
      );
      expect(g.calls.where((x) => x.$1 == 'answer'), isEmpty);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  for (final width in [390.0, 651.0, 1024.0]) {
    testWidgets('confirm footer and editor fit $width at 2x text', (
      t,
    ) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = Size(width, 1400);
      addTearDown(t.view.reset);
      await t.pumpWidget(
        shell(
          Column(
            children: [
              NativeInteractionCard(
                question: {
                  ...question('confirm'),
                  'description': 'One\nTwo',
                  'expiresAt': '2050-01-01T00:00:00Z',
                },
                onAnswer: (_) async {},
              ),
              NativeInteractionCard(
                question: question('editor'),
                onAnswer: (_) async {},
              ),
            ],
          ),
          scale: 2,
        ),
      );
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
    });
  }
}
