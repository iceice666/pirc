import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/interaction.dart';
import 'package:pirc_mobile/live/interaction_card.dart';
import 'live_test.dart' show FakeGateway, theme;

final fixture = obj(
  jsonDecode(
    File(
      '../../fixtures/mobile-parity/memory-interactions.json',
    ).readAsStringSync(),
  ),
);
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
  testWidgets(
    'memory confirmations preserve literal paragraphs, labels and exact decisions',
    (t) async {
      for (final q in rows(fixture['questions'])) {
        for (final approve in [false, true]) {
          Json? answer;
          await t.pumpWidget(
            shell(
              NativeInteractionCard(
                key: UniqueKey(),
                question: q,
                onAnswer: (value) async {
                  answer = value;
                },
              ),
            ),
          );
          expect(find.text('${q['description']}'), findsOneWidget);
          expect(
            find.descendant(
              of: find.byType(SelectionArea),
              matching: find.text('${q['description']}'),
            ),
            findsOneWidget,
          );
          expect(
            find.text(
              'Choose whether the agent should continue with this action.',
            ),
            findsNothing,
          );
          final button = find.widgetWithText(
            TextButton,
            approve ? 'Approve' : 'Reject',
          );
          await t.ensureVisible(button);
          await t.pump();
          await t.tap(button);
          await t.pump();
          expect(answer, {'confirmed': approve});
          await t.pumpWidget(const SizedBox());
        }
      }
    },
  );
  testWidgets(
    'answer from old revision cannot remove a replacement confirmation',
    (t) async {
      final g = FakeGateway(),
          c = LiveController(g)
            ..sessionId = 's'
            ..connection = 'live'
            ..control = {'held': true}
            ..origin = 'https://gateway.example'
            ..pairingStamp = 'test-pairing';
      final q = rows(fixture['questions'])[1], pending = Completer<dynamic>();
      c.state = {
        'interactions': [q],
      };
      g.handler = (method, args) async =>
          method == 'answer' ? pending.future : g.normal(method, args);
      await t.pumpWidget(
        shell(QuestionSheet(controller: c, question: q, embedded: true)),
      );
      final button = find.widgetWithText(TextButton, 'Approve');
      await t.ensureVisible(button);
      await t.pump();
      await t.tap(button);
      await t.pump();
      final next = {
        ...q,
        'id': 'memory:replace:3',
        'description': 'New target revision; review again.',
      };
      c.state = {
        'interactions': [next],
      };
      pending.complete({});
      await t.pumpAndSettle();
      expect(c.questions.single, next);
      final call = g.calls.singleWhere((e) => e.$1 == 'answer');
      expect(call.$2, {
        'sessionId': 's',
        'interactionId': q['id'],
        'epoch': '0',
        'origin': 'https://gateway.example',
        'pairingStamp': 'test-pairing',
        'answer': {'confirmed': true},
      });
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'full proposals stay reachable at phone/tablet widths and large text',
    (t) async {
      for (final width in [390.0, 651.0, 1024.0]) {
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = Size(width, 844);
        await t.pumpWidget(
          shell(
            Column(
              children: [
                for (final q in rows(fixture['questions']))
                  NativeInteractionCard(question: q, onAnswer: (_) async {}),
              ],
            ),
            scale: 2,
          ),
        );
        await t.ensureVisible(find.widgetWithText(TextButton, 'Reject').last);
        await t.pump();
        expect(t.takeException(), isNull);
        expect(
          find.text('${rows(fixture['questions']).last['description']}'),
          findsOneWidget,
        );
        await t.pumpWidget(const SizedBox());
      }
      t.view.reset();
    },
  );
}
