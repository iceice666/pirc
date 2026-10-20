import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/interaction.dart';
import 'package:pirc_mobile/live/interaction_card.dart';
import 'live_test.dart' show FakeGateway, theme;

const relayId = 'relay.d1.interaction_7';

Json relayed() => {
  'id': relayId,
  'epoch': '0',
  'kind': 'confirm',
  'status': 'pending',
  'title': 'Run rm -rf build?',
  'description': 'Auto mode stopped a dangerous command',
  'confirmLabel': 'Allow',
  'cancelLabel': 'Deny',
  'relayed': {
    'sessionId': 'delegated',
    'sessionName': 'Fix build',
    'workspace': 'repo on mac',
    'delegationId': 'd1',
  },
};

Json chatSnapshot(List<Json> interactions) => {
  'session': {'id': 'chat', 'name': 'Chat'},
  'interactions': interactions,
};

Widget app(Widget child) => MaterialApp(
  theme: theme.build(Brightness.light),
  home: Scaffold(body: SingleChildScrollView(child: child)),
);

void main() {
  test('relay ids and labels', () {
    expect(isRelayedInteraction(relayed()), isTrue);
    expect(isRelayedInteraction({'id': 'interaction_7'}), isFalse);
    expect(isRelayedInteraction(null), isFalse);
    expect(relayedFromLabel(relayed()), 'From Fix build (repo on mac)');
    expect(relayedFromLabel({'id': 'q'}), isNull);
  });

  testWidgets(
    'embedded relayed card answers without the control lease and opens its session',
    (tester) async {
      final gateway = FakeGateway(), q = relayed();
      gateway.snapshot = chatSnapshot([q]);
      // Another device holds the chat: ordinary questions would be read-only.
      final controller = LiveController(gateway)
        ..sessionId = 'chat'
        ..connection = 'live'
        ..control = {'held': false, 'holderClientId': 'web'}
        ..origin = 'https://gateway.test'
        ..pairingStamp = 'pairing-1'
        ..state = chatSnapshot([q]);
      final answers = <Json>[];
      gateway.handler = (method, args) async {
        if (method == 'answer') {
          answers.add(args);
          return chatSnapshot([]);
        }
        return gateway.normal(method, args);
      };

      await tester.pumpWidget(
        app(QuestionSheet(controller: controller, question: q, embedded: true)),
      );
      await tester.pumpAndSettle();
      expect(find.text('From Fix build (repo on mac)'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('interaction-relayed-open')),
        findsOneWidget,
      );

      await tester.tap(find.text('Allow'));
      await tester.pumpAndSettle();
      expect(answers, hasLength(1));
      expect(answers.single['interactionId'], relayId);
      expect(answers.single['answer'], {'confirmed': true});
      expect(gateway.calls.where((c) => c.$1 == 'control'), isEmpty);

      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets(
    'notification sheet for a relayed card never offers take control',
    (tester) async {
      final gateway = FakeGateway(), q = relayed();
      gateway.snapshot = chatSnapshot([q]);
      final controller = LiveController(gateway)
        ..sessionId = 'chat'
        ..connection = 'live'
        ..control = {'held': false}
        ..origin = 'https://gateway.test'
        ..pairingStamp = 'pairing-1'
        ..state = chatSnapshot([q]);
      await tester.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showModalBottomSheet<void>(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) => QuestionSheet(
                    controller: controller,
                    question: q,
                    notificationPairingStamp: 'pairing-1',
                  ),
                ),
                child: const Text('Open notification'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open notification'));
      await tester.pumpAndSettle();

      expect(find.text('Take control'), findsNothing);
      expect(gateway.calls.where((c) => c.$1 == 'control'), isEmpty);
      final allow = tester.widget<TextButton>(
        find.ancestor(
          of: find.text('Allow'),
          matching: find.byType(TextButton),
        ),
      );
      expect(allow.onPressed, isNotNull);

      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  test('stop and relayed approval go through the native API layer', () async {
    final gateway = FakeGateway();
    gateway.handler = (method, args) async =>
        method == 'stopDelegation' || method == 'answerRelayed'
        ? {'status': 'ok'}
        : gateway.normal(method, args);
    final controller = LiveController(gateway)..pairingStamp = 'pairing-1';
    await controller.stopDelegation('d1');
    await controller.answerRelayedApproval('chat', relayId, false);
    expect(gateway.calls.firstWhere((c) => c.$1 == 'stopDelegation').$2, {
      'delegationId': 'd1',
    });
    expect(gateway.calls.firstWhere((c) => c.$1 == 'answerRelayed').$2, {
      'sessionId': 'chat',
      'interactionId': relayId,
      'pairingStamp': 'pairing-1',
      'confirmed': false,
    });
    controller.dispose();
    await gateway.stream.close();
  });
}
